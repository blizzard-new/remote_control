package org.remotecontrol.share;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import okhttp3.OkHttpClient;
import org.json.JSONObject;

/** Binds a short-lived pairing code and previously approved device channels to one screen share. */
final class PhoneShare implements AutoCloseable {
  private final String address;
  private final PhoneDevices devices;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final OkHttpClient client =
      new OkHttpClient.Builder().pingInterval(22, TimeUnit.SECONDS).build();
  private final Map<String, Channel> channels = new LinkedHashMap<>();
  private final PinDirectory directory;
  private byte[] frame;
  private boolean closed;

  private static final class Channel {
    final JSONObject pair;
    InternetHost host;
    boolean saved;

    Channel(JSONObject pair, boolean saved) {
      this.pair = pair;
      this.saved = saved;
    }
  }

  PhoneShare(Context context, String address, Consumer<String> stopped) {
    okhttp3.HttpUrl parsed = okhttp3.HttpUrl.get(address);
    if (!parsed.isHttps()
        || !parsed.username().isEmpty()
        || !parsed.password().isEmpty()
        || parsed.query() != null
        || parsed.fragment() != null) throw new IllegalArgumentException("請輸入 HTTPS 配對服務網址");
    this.address = parsed.toString().replaceFirst("/+$", "");
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
                stopped.accept("配對服務已離線，請重新開啟分享。");
              }
            });
  }

  synchronized void start() throws Exception {
    for (JSONObject pair : devices.list())
      if (address.equals(pair.getString("address"))) listen(pair, true, () -> {});
    directory.start();
  }

  private synchronized void listen(JSONObject pair, boolean saved, Runnable ready)
      throws Exception {
    if (closed || channels.size() >= 24) throw new IllegalStateException();
    String key = pair.getString("listen");
    Channel c = new Channel(pair, saved);
    c.host =
        new InternetHost(
            address,
            msg -> main.post(() -> remove(key)),
            client,
            Base64.decode(key, Base64.URL_SAFE),
            ready,
            false);
    channels.put(key, c);
    c.host.start();
    if (frame != null) c.host.publish(frame);
    if (!saved)
      main.postDelayed(
          () -> {
            synchronized (PhoneShare.this) {
              if (!c.saved) remove(key);
            }
          },
          150000);
  }

  private synchronized void remove(String key) {
    Channel c = channels.remove(key);
    if (c != null) c.host.close();
  }

  String invitation() {
    return directory.code();
  }

  synchronized int viewers() {
    int count = 0;
    for (Channel c : channels.values()) count += c.host.viewers();
    return count;
  }

  synchronized String status() {
    String pin = invitation();
    return pin.isEmpty()
        ? "正在取得四位數配對碼…"
        : "四位數配對碼　" + pin + "\n\n在電腦輸入這四碼。已配對的電腦可直接點選手機名稱。\n已連線：" + viewers();
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
        out.put(item.getKey() + "." + request.getKey(), label);
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
    if (allow && !c.saved) {
      try {
        c.pair.put("name", name).put("address", address);
        c.saved = !devices.update("save", c.pair.toString()).equals("null");
      } catch (Exception ignored) {
      }
    }
    c.host.decide(viewer, allow, control, c.saved);
  }

  synchronized void forget(String key) {
    remove(key);
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
