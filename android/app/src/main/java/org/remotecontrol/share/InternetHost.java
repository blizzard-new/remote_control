package org.remotecontrol.share;

import android.util.Base64;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/** An attended Android capture session. Keys stay on the devices. */
final class InternetHost extends WebSocketListener implements AutoCloseable {
  static final String DEFAULT = "https://remote.uniway-tw.com";
  private static final SecureRandom random = new SecureRandom();
  private final byte[] seed;
  private final Runnable onReady;
  private final boolean ownsClient;
  private final Map<Integer, Peer> peers = new LinkedHashMap<>();
  private final OkHttpClient client;
  private final Consumer<String> stopped;
  private final String base;
  private WebSocket socket;
  private byte[] latestFrame;
  private boolean closed, ready, sharing;
  volatile String grant = "";
  interface Resume {
    String answer(org.json.JSONArray offers) throws Exception;
  }
  Resume resume;
  java.util.function.BiConsumer<String, String> identify = (name, platform) -> {};
  java.util.function.Supplier<String> displayName = () -> android.os.Build.MODEL;

  InternetHost(String address, Consumer<String> stopped) {
    this(address, stopped, new OkHttpClient.Builder().pingInterval(22, TimeUnit.SECONDS).build());
  }

  InternetHost(String address, Consumer<String> stopped, OkHttpClient client) {
    this(address, stopped, client, randomBytes(24), () -> {}, true);
  }

  InternetHost(
      String address,
      Consumer<String> stopped,
      OkHttpClient client,
      byte[] seed,
      Runnable onReady,
      boolean ownsClient) {
    this.client = client;
    this.seed = seed;
    this.onReady = onReady;
    this.ownsClient = ownsClient;
    URI uri = URI.create(address);
    if (!"https".equalsIgnoreCase(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null) throw new IllegalArgumentException("請填入 HTTPS 配對服務網址。");
    base = uri.toASCIIString().replaceFirst("/+$", "");
    this.stopped = stopped;
  }

  synchronized void start() {
    socket = client.newWebSocket(new Request.Builder().url(base + "/v1/session").build(), this);
  }

  synchronized String status() {
    if (!ready) return "正在連接跨網路配對服務…";
    return "跨網路邀請碼\n" + invitation() + "\n\n將邀請碼交給觀看者，再核准下方的請求。\n觀看中：" + viewers();
  }

  synchronized String invitation() {
    return ready ? "rc1." + b64(base.getBytes(StandardCharsets.US_ASCII)) + "." + b64(seed) : "";
  }

  synchronized Map<Integer, String> pending() {
    Map<Integer, String> result = new LinkedHashMap<>();
    for (Peer p : peers.values().toArray(new Peer[0])) {
      if (!p.approved && android.os.SystemClock.elapsedRealtime() - p.started > 120000) drop(p.id);
      else if (p.name != null && !p.approved && !p.redirected && !trusted(p) && !p.awaitControl) result.put(p.id, p.name);
    }
    return result;
  }

  synchronized int viewers() {
    int count = 0;
    for (Peer p : peers.values()) if (p.approved) count++;
    return count;
  }

  synchronized void appendConnected(org.json.JSONArray out) throws org.json.JSONException {
    for (Peer p : peers.values())
      if (p.approved) out.put(new JSONObject().put("name", p.name).put("control", p.control));
  }

  synchronized String platform(int id) {
    Peer peer = peers.get(id);
    return peer == null ? "" : peer.platform;
  }

  synchronized boolean requestedControl(int id) {
    Peer peer = peers.get(id);
    return peer != null && !peer.viewOnly;
  }

  private boolean trusted(Peer p) {
    return "control".equals(grant) || (p.viewOnly && "view".equals(grant));
  }

  synchronized void startSharing() {
    sharing = true;
    refreshRequests();
  }

  synchronized void refreshRequests() {
    for (Peer p : peers.values().toArray(new Peer[0])) {
      if (p.approved || p.redirected) continue;
      if (android.os.SystemClock.elapsedRealtime() - p.started > 120000) drop(p.id);
      else if (p.name != null) checkRequest(p);
    }
  }

  private void checkRequest(Peer p) {
    if (!sharing) waiting(p, "projection");
    else if (trusted(p) || p.awaitControl)
      decide(p.id, true, !p.viewOnly, trusted(p) || p.rememberDecision);
    else if (!p.viewOnly)
      waiting(p, PhoneControl.busy() ? "busy" : PhoneControl.available() ? "approval" : "access");
  }

  private void waiting(Peer p, String reason) {
    if (reason.equals(p.reason)) return;
    p.reason = reason;
    try {
      send(p, 1, new JSONObject().put("t","control-pending").put("reason",reason)
          .put("platform","Android").put("canView",true).toString().getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) { drop(p.id); }
  }
  synchronized void decide(int id, boolean allow) {
    decide(id, allow, false, false);
  }

  synchronized void decide(int id, boolean allow, boolean control, boolean remembered) {
    Peer p = peers.get(id);
    if (p == null || p.name == null || p.approved || p.redirected || (allow && !sharing)) return;
    try {
      if (allow) {
        if (control && !p.viewOnly && !PhoneControl.claim(p)) {
          p.awaitControl = true;
          p.rememberDecision = remembered;
          waiting(p, PhoneControl.busy() ? "busy" : "access");
          return;
        }
        if (remembered) identify.accept(p.name, p.platform);
        p.approved = true;
        p.control = control && !p.viewOnly;
        send(
            p,
            1,
            new JSONObject()
                .put("t", "approved")
                .put("control", p.control)
                .put("name", displayName.get())
                .put("platform", "Android")
                .put("qualityControls", true)
                .put("remembered", remembered)
                .toString()
                .getBytes(StandardCharsets.UTF_8));
        if (latestFrame != null) send(p, 2, latestFrame);
      } else drop(id);
    } catch (Exception e) {
      drop(id);
    }
  }

  // Zero means JPEG, -1 means this channel has no viewers.
  synchronized int codecProfile() {
    int profile = -1;
    for (Peer p : peers.values()) if (p.approved) {
      int candidate = p.avc ? VideoQuality.codecProfile(p.edge, p.fps, p.quality) : 0;
      if (profile != -1 && candidate != profile) return 0;
      profile = candidate;
    }
    return profile;
  }
  private long windowStart, windowBytes;
  synchronized void video(boolean key, byte[] packet) {
    if (closed || socket == null) return;
    long now = android.os.SystemClock.elapsedRealtime();
    if (now-windowStart >= 1000) {windowStart=now; windowBytes=0;}
    for (Peer p : peers.values().toArray(new Peer[0])) {
      if (!p.approved || !p.avc) continue;
      if (packet.length > 375000 && key) {p.avc=false; continue;}
      if (packet.length > 375000 || socket.queueSize() > 420000 || windowBytes+packet.length > 3700000) {
        p.needsKey = true; continue;
      }
      if (p.needsKey && !key) continue;
      try { send(p,3,packet); p.needsKey=false; windowBytes+=packet.length+32; }
      catch(Exception e) { drop(p.id); }
    }
  }

  synchronized int edge() {
    int edge = 0;
    for (Peer p : peers.values()) if (p.approved) edge = Math.max(edge, p.edge);
    return edge;
  }

  synchronized boolean wants(int edge, VideoQuality quality) {
    for (Peer p : peers.values()) if (p.wants(edge, quality)) return true;
    return false;
  }

  synchronized int fps() {
    int fps = 0;
    for (Peer p : peers.values()) if (p.approved) fps = Math.max(fps, p.fps);
    return fps;
  }

  synchronized void publish(byte[] jpeg) {
    if (closed || jpeg.length > VideoQuality.SINGLE_IMAGE) return;
    latestFrame = jpeg;
    for (Peer p : peers.values().toArray(new Peer[0])) {
      if (p.approved && socket.queueSize() < 420000) {
        try { send(p, 2, jpeg); } catch (Exception e) { drop(p.id); }
      }
    }
  }

  private long nextWire;
  synchronized void publish(byte[] jpeg, int edge, VideoQuality quality, android.os.Handler worker) {
    if (closed || socket == null || jpeg.length > quality.maxBytes || socket.queueSize() > 512000) return;
    for (Peer p : peers.values().toArray(new Peer[0])) {
      if (!p.wants(edge, quality)) continue;
      p.sendingImage = true;
      p.nextFrame = android.os.SystemClock.uptimeMillis() + 1000 / p.fps - 1;
      queuePiece(p, jpeg, 0, worker);
    }
  }

  private void queuePiece(Peer p, byte[] jpeg, int offset, android.os.Handler worker) {
    boolean fragmented = jpeg.length > VideoQuality.SINGLE_IMAGE;
    int size = fragmented ? Math.min(VideoQuality.PIECE_BYTES, jpeg.length - offset) : jpeg.length;
    long due = Math.max(nextWire, android.os.SystemClock.uptimeMillis());
    nextWire = due + (size + 64 + 3199) / 3200;
    worker.postAtTime(new Runnable() {
      @Override public void run() {
        synchronized (InternetHost.this) {
          if (closed || peers.get(p.id) != p || !p.approved) {
            p.sendingImage = false;
            return;
          }
          if (socket.queueSize() > VideoQuality.PIECE_BYTES) {
            worker.postDelayed(this, 40);
            return;
          }
          try {
            if (fragmented) {
              byte[] piece = ByteBuffer.allocate(size + 8).putInt(jpeg.length).putInt(offset)
                  .put(jpeg, offset, size).array();
              send(p, 4, piece);
            } else send(p, 2, jpeg);
            if (offset + size < jpeg.length) queuePiece(p, jpeg, offset + size, worker);
            else p.sendingImage = false;
          } catch (Exception e) { drop(p.id); }
        }
      }
    }, due);
  }

  @Override
  public synchronized void onOpen(WebSocket ws, Response response) {
    if (closed) return;
    try {
      String room = hex(MessageDigest.getInstance("SHA-256").digest(seed)).substring(0, 32);
      ws.send(new JSONObject().put("room", room).put("role", "host").toString());
    } catch (Exception e) {
      end();
    }
  }

  @Override
  public synchronized void onMessage(WebSocket ws, String text) {
    if (closed || text.length() > 1024) return;
    try {
      JSONObject m = new JSONObject(text);
      String t = m.getString("t");
      if (t.equals("ready")) {
        ready = true;
        onReady.run();
        return;
      }
      int id = (int) m.getLong("id");
      if (t.equals("left")) {
        Peer old = peers.remove(id);
        if (old != null) PhoneControl.release(old);
        return;
      }
      if (!t.equals("join") || peers.size() >= 8 || peers.containsKey(id)) return;
      byte[] host = randomBytes(16);
      byte[] viewer = unhex(m.getString("nonce"));
      byte[] salt = ByteBuffer.allocate(32).put(host).put(viewer).array();
      byte[] prk = hmac(salt, seed);
      Peer p = new Peer(id, derive(prk, "share"), derive(prk, "view"));
      peers.put(id, p);
      ws.send(
          new JSONObject()
              .put("t", "hello")
              .put("id", Integer.toUnsignedLong(id))
              .put("nonce", hex(host))
              .toString());
    } catch (Exception e) {
      end();
    }
  }

  @Override
  public synchronized void onMessage(WebSocket ws, ByteString message) {
    if (closed || message.size() < 21 || message.size() > 2048) return;
    ByteBuffer packet = message.asByteBuffer();
    int id = packet.getInt();
    Peer p = peers.get(id);
    if (p == null) return;
    try {
      byte[] ciphertext = new byte[packet.remaining()];
      packet.get(ciphertext);
      byte[] data = crypt(Cipher.DECRYPT_MODE, p.rx, p.incoming++, ciphertext);
      if (data[0] != 1) {
        drop(id);
        return;
      }
      JSONObject m = new JSONObject(new String(data, 1, data.length - 1, StandardCharsets.UTF_8));
      if ("request".equals(m.optString("t")) && p.name == null) {
        String name = m.getString("name").trim();
        if (name.isEmpty() || name.length() > 64) {
          drop(id);
          return;
        }
        p.name = name;
        p.platform = m.optString("platform");
        p.frameParts = m.optBoolean("frameParts", false);
        p.profile(m);
        p.viewOnly = m.optBoolean("viewOnly");
        String proof = resume == null ? null : resume.answer(m.optJSONArray("resume"));
        if (proof != null) {
          p.redirected = true;
          send(p, 1, new JSONObject().put("t","resume").put("proof",proof)
              .toString().getBytes(StandardCharsets.UTF_8));
        } else checkRequest(p);
      } else if ("view-only".equals(m.optString("t")) && p.name != null && !p.approved && !p.redirected) {
        p.viewOnly = true;
        p.awaitControl = false;
        checkRequest(p);
      } else if (p.approved && "quality".equals(m.optString("t"))) {
        p.profile(m);
      } else if (p.approved && p.control && "input".equals(m.optString("t"))) {
        PhoneControl.input(p, m.optJSONObject("event"));
      }
    } catch (Exception e) {
      drop(id);
    }
  }

  @Override
  public synchronized void onFailure(WebSocket ws, Throwable t, Response r) {
    end();
  }

  @Override
  public synchronized void onClosing(WebSocket ws, int code, String reason) {
    ws.close(code, null);
    end();
  }

  private void end() {
    if (!closed) {
      close();
      stopped.accept("配對服務已離線，請確認網路並重新分享。");
    }
  }

  private void drop(int id) {
    Peer removed = peers.remove(id);
    if (removed != null) PhoneControl.release(removed);
    try {
      socket.send(
          new JSONObject().put("t", "drop").put("id", Integer.toUnsignedLong(id)).toString());
    } catch (Exception ignored) {
      end();
    }
  }

  private void send(Peer p, int type, byte[] data) throws Exception {
    byte[] plain = ByteBuffer.allocate(1 + data.length).put((byte) type).put(data).array();
    byte[] bytes = crypt(Cipher.ENCRYPT_MODE, p.tx, p.outgoing++, plain);
    if (!socket.send(
        ByteString.of(ByteBuffer.allocate(4 + bytes.length).putInt(p.id).put(bytes).array())))
      end();
  }

  @Override
  public synchronized void close() {
    if (closed) return;
    closed = true;
    ready = false;
    latestFrame = null;
    for (Peer peer : peers.values()) PhoneControl.release(peer);
    peers.clear();
    if (socket != null) socket.cancel();
    if (ownsClient) {
      client.dispatcher().executorService().shutdown();
      client.connectionPool().evictAll();
    }
  }

  private static final class Peer {
    final long started = android.os.SystemClock.elapsedRealtime();
    final int id;
    final byte[] tx, rx;
    long outgoing, incoming;
    boolean approved, control, viewOnly, redirected, awaitControl, rememberDecision;
    String reason;
    boolean avc, needsKey=true;
    int edge = 1920, fps = 30;
    boolean sendingImage, frameParts;
    VideoQuality quality = VideoQuality.LEGACY;
    boolean wants(int requestedEdge, VideoQuality requestedQuality) {
      return approved && !sendingImage && edge == requestedEdge && quality == requestedQuality
          && android.os.SystemClock.uptimeMillis() >= nextFrame;
    }
    long nextFrame;
    void profile(JSONObject m) {
      avc = m.optBoolean("avc",false); needsKey=true;
      edge = VideoQuality.edge(m.optInt("edge", 1920));
      quality = !frameParts ? VideoQuality.LEGACY :
          m.optBoolean("sharp", false) ? VideoQuality.SHARP : VideoQuality.BALANCED;
      fps = m.optInt("fps", 30) == 60 ? 60 : 30;
    }
    String name, platform = "";

    Peer(int id, byte[] tx, byte[] rx) {
      this.id = id;
      this.tx = tx;
      this.rx = rx;
    }
  }

  private static byte[] crypt(int mode, byte[] key, long seq, byte[] data) throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    byte[] iv = ByteBuffer.allocate(12).putInt(0).putLong(seq).array();
    c.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
    return c.doFinal(data);
  }

  private static byte[] hmac(byte[] key, byte[] input) throws Exception {
    Mac m = Mac.getInstance("HmacSHA256");
    m.init(new SecretKeySpec(key, "HmacSHA256"));
    return m.doFinal(input);
  }

  private static byte[] derive(byte[] prk, String direction) throws Exception {
    return hmac(
        prk, ("remote-control/v1/" + direction + "\u0001").getBytes(StandardCharsets.UTF_8));
  }

  private static String b64(byte[] b) {
    return Base64.encodeToString(b, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
  }

  private static byte[] randomBytes(int n) {
    byte[] b = new byte[n];
    random.nextBytes(b);
    return b;
  }

  private static String hex(byte[] b) {
    StringBuilder s = new StringBuilder();
    for (byte x : b) s.append(String.format(java.util.Locale.ROOT, "%02x", x));
    return s.toString();
  }

  private static byte[] unhex(String s) {
    if (!s.matches("[a-f0-9]{32}")) throw new IllegalArgumentException();
    byte[] b = new byte[16];
    for (int i = 0; i < 16; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
    return b;
  }
}
