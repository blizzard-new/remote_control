package org.remotecontrol.share;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import java.util.*;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import org.json.JSONObject;

/** The protected code page can register an address before Android authorizes any capture. */
final class PhoneShare implements AutoCloseable {
  private static PhoneShare preview;
  private final String address;
  private final PhoneDevices devices;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final OkHttpClient client;
  private final Map<String, Channel> channels = new LinkedHashMap<>();
  private final Map<String, Integer> retries = new HashMap<>();
  private final PinDirectory directory;
  private byte[] frame;
  private boolean closed, sharing;
  private volatile boolean reconnecting;
  private String saveError = "";

  private static final class Channel {
    final JSONObject pair;
    InternetHost host;
    boolean saved;

    Channel(JSONObject pair, boolean saved) {
      this.pair = pair;
      this.saved = saved;
    }
  }

  static synchronized PhoneShare prepare(Context context, String address) throws Exception {
    return prepare(context, address, () -> new OkHttpClient.Builder().pingInterval(22, TimeUnit.SECONDS).build());
  }

  static synchronized PhoneShare prepare(Context context, String address, java.util.function.Supplier<OkHttpClient> clients) throws Exception {
    String normalized = okhttp3.HttpUrl.get(address).toString().replaceFirst("/+$", "");
    if (preview == null || !preview.address.equals(normalized)) {
      releasePreview(preview);
      PhoneShare host = new PhoneShare(context.getApplicationContext(), normalized, clients.get());
      try { host.start(); }
      catch (Exception e) { host.close(); throw e; }
      preview = host;
    }
    return preview;
  }

  static synchronized PhoneShare takeForCapture(Context context, String address) throws Exception {
    PhoneShare host = prepare(context, address);
    preview = null;
    return host;
  }

  static synchronized void releasePreview(PhoneShare host) {
    if (host != null && host == preview) {
      preview = null;
      host.close();
    }
  }

  static synchronized void forgetPreview(String key) {
    if (preview != null) preview.forget(key);
  }

  private PhoneShare(Context context, String address, OkHttpClient client) {
    okhttp3.HttpUrl parsed = okhttp3.HttpUrl.get(address);
    if (!parsed.isHttps()
        || !parsed.username().isEmpty()
        || !parsed.password().isEmpty()
        || parsed.query() != null
        || parsed.fragment() != null) throw new IllegalArgumentException("請輸入 HTTPS 配對服務網址");
    this.address = parsed.toString().replaceFirst("/+$", "");
    this.client = client;
    devices = new PhoneDevices(context);
    directory =
        new PinDirectory(
            this.address,
            client,
            new PinDirectory.Listener() {
              public void offer(JSONObject pair, Runnable ready) throws Exception {
                listen(pair, false, ready);
              }

              public void stopped() {
                reconnecting = true;
              }
            });
  }

  private synchronized void start() throws Exception {
    directory.start();
    for (JSONObject pair : devices.list())
      if (address.equals(pair.getString("address"))) listen(pair, true, () -> {});
  }

  synchronized void startSharing() {
    sharing = true;
    for (Channel c : channels.values()) c.host.startSharing();
  }

  synchronized boolean sharing() {
    return sharing;
  }

  private synchronized void listen(JSONObject pair, boolean saved, Runnable ready)
      throws Exception {
    if (closed || channels.size() >= 24) throw new IllegalStateException();
    String key = pair.getString("listen");
    Channel c = new Channel(pair, saved);
    c.host =
        new InternetHost(
            address,
            msg -> main.post(() -> disconnected(key, c)),
            client,
            Base64.decode(key, Base64.URL_SAFE),
            () -> { main.post(() -> { synchronized (PhoneShare.this) { retries.remove(key); } }); ready.run(); },
            false);
    c.host.displayName = devices::displayName;
    c.host.identify = (name, platform) -> {
      try {
        JSONObject identity = new JSONObject().put("listen", key).put("dial", pair.getString("dial"))
            .put("address", address).put("name", name).put("platform", platform);
        devices.update("identify", identity.toString());
      } catch (org.json.JSONException ignored) {
      }
    };
    c.host.grant = saved ? pair.optString("grant") : "";
    if (!saved) c.host.resume = offers -> devices.resumeAnswer(offers, address, key);
    if (sharing) c.host.startSharing();
    channels.put(key, c);
    c.host.start();
    if (frame != null) c.host.publish(frame);
    if (!saved)
      main.postDelayed(
          () -> {
            synchronized (PhoneShare.this) {
              if (!c.saved && channels.get(key) == c) remove(key);
            }
          },
          150000);
  }

  private synchronized void remove(String key) {
    Channel c = channels.remove(key);
    if (c != null) c.host.close();
  }

  private synchronized void disconnected(String key, Channel c) {
    if (closed || channels.get(key) != c) return;
    remove(key);
    if (!c.saved) return;
    int failures = retries.getOrDefault(key, 0);
    retries.put(key, failures + 1);
    main.postDelayed(() -> {
      synchronized (PhoneShare.this) {
        if (closed || !retries.containsKey(key) || channels.containsKey(key)) return;
        try {
          for (JSONObject pair : devices.list())
            if (key.equals(pair.optString("listen")) && address.equals(pair.optString("address"))) {
              listen(pair, true, () -> {});
              break;
            }
        } catch (Exception ignored) { }
      }
    }, Math.min(60000L, 1000L << Math.min(failures, 6)));
  }

  String invitation() {
    return directory.code();
  }

  synchronized void appendConnected(org.json.JSONArray out) throws org.json.JSONException {
    for (Channel c : channels.values()) c.host.appendConnected(out);
  }

  synchronized int viewers() {
    int count = 0;
    for (Channel c : channels.values()) count += c.host.viewers();
    return count;
  }

  synchronized String status() {
    for (Channel c : channels.values()) c.host.refreshRequests();
    String pin = invitation();
    if (pin.isEmpty()) return reconnecting ? "配對服務暫時連不上，正在重試。請確認手機網路與配對服務網址。" : "正在取得手機的四位數連線碼…";
    reconnecting = false;
    return "手機連線碼　" + pin + (sharing
        ? "\n\n螢幕分享中。連線後請切回主畫面或開啟要分享的 App。連線碼頁受系統保護。\n已連線：" + viewers() + saveError
        : "\n\n在電腦輸入這四碼。準備好後，按「開放整個螢幕連線」。");
  }

  synchronized Map<String, String> pending() {
    Map<String, String> out = new LinkedHashMap<>();
    for (Map.Entry<String, Channel> item : channels.entrySet()) {
      Channel c = item.getValue();
      for (Map.Entry<Integer, String> request : c.host.pending().entrySet()) {
        String label =
            c.saved
                ? c.pair.optString("name") + "（已配對）"
                : request.getValue() + " · 核對 " + c.pair.optString("check");
        String mode = c.host.requestedControl(request.getKey()) ? " · 要求操作" : " · 要求觀看";
        out.put(item.getKey() + "." + request.getKey(), label + mode);
      }
    }
    return out;
  }

  synchronized void decide(String id, boolean allow, boolean control) {
    String[] parts = id.split("\\.");
    if (parts.length != 2) return;
    Channel c = channels.get(parts[0]);
    if (c == null) return;
    int viewer = Integer.parseInt(parts[1]);
    String name = c.host.pending().get(viewer);
    if (name == null) return;
    control = control && c.host.requestedControl(viewer);
    if (allow && !sharing) return;
    boolean remembered = c.saved;
    if (allow && (c.host.grant.isEmpty() || (control && !"control".equals(c.host.grant)))) {
      remembered = false;
      try {
        c.pair.put("name", name).put("platform", c.host.platform(viewer)).put("address", address).put("grant", control ? "control" : "view");
        if (!devices.update("save", c.pair.toString()).equals("null")) {
          c.saved = true;
          remembered = true;
          c.host.grant = c.pair.getString("grant");
          c.host.resume = null;
        }
      } catch (Exception ignored) {
      }
      saveError = remembered ? "" : "\n無法儲存這次授權。請檢查儲存空間，或在裝置列表解除不再使用的配對。";
    }
    c.host.decide(viewer, allow, control, remembered);
  }

  synchronized void forget(String key) {
    retries.remove(key);
    remove(key);
  }

  synchronized boolean requestedControl(String id) {
    String[] parts = id.split("\\.");
    Channel c = parts.length == 2 ? channels.get(parts[0]) : null;
    return c != null && c.host.requestedControl(Integer.parseInt(parts[1]));
  }

  synchronized int codecProfile() {
    int profile = -1;
    for (Channel c : channels.values()) {
      int candidate=c.host.codecProfile();
      if (candidate == -1) continue;
      if (profile != -1 && profile != candidate) return 0;
      profile=candidate;
    }
    return Math.max(0,profile);
  }
  synchronized void video(long timeUs, boolean key, byte[] unit) {
    if (closed || unit.length == 0) return;
    byte[] packet = java.nio.ByteBuffer.allocate(9+unit.length).put((byte)(key?1:0)).putLong(timeUs).put(unit).array();
    for (Channel c : channels.values()) c.host.video(key,packet);
  }

  synchronized int fps() {
    int value = 0;
    for (Channel c : channels.values()) value = Math.max(value,c.host.fps());
    return value;
  }

  synchronized void publish(android.graphics.Bitmap source, java.io.ByteArrayOutputStream buffer, android.os.Handler worker) {
    if (closed) return;
    for (int edge : VideoQuality.EDGES) {
      android.graphics.Bitmap image = null;
      try {
        for (VideoQuality quality : VideoQuality.values()) {
          boolean wanted = false;
          for (Channel c : channels.values()) if (c.host.wants(edge, quality)) { wanted = true; break; }
          if (!wanted) continue;
          if (image == null) {
            double scale = Math.min(1d, edge / (double)Math.max(source.getWidth(),source.getHeight()));
            image = scale == 1 ? source : android.graphics.Bitmap.createScaledBitmap(source,
                Math.max(1,(int)Math.round(source.getWidth()*scale)), Math.max(1,(int)Math.round(source.getHeight()*scale)), true);
          }
          for (int level : quality.levels) {
            buffer.reset();
            if (!image.compress(android.graphics.Bitmap.CompressFormat.JPEG, level, buffer)) break;
            if (buffer.size() > quality.maxBytes) continue;
            byte[] data = buffer.toByteArray();
            for (Channel c : channels.values()) c.host.publish(data, edge, quality, worker);
            break;
          }
        }
      } finally {
        if (image != null && image != source) image.recycle();
      }
    }
  }

  synchronized void publish(byte[] jpeg) {
    if (!closed) {
      frame = jpeg;
      for (Channel c : channels.values()) c.host.publish(jpeg);
    }
  }

  @Override
  public synchronized void close() {
    closed = true;
    directory.close();
    main.removeCallbacksAndMessages(null);
    for (Channel c : channels.values()) c.host.close();
    channels.clear();
    frame = null;
    client.connectionPool().evictAll();
    client.dispatcher().executorService().shutdown();
  }
}
