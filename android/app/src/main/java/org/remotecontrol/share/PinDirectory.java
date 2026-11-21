package org.remotecontrol.share;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.*;
import okio.ByteString;
import org.json.JSONObject;

/** Four-digit discovery on the existing relay. Only ephemeral public keys cross this room. */
final class PinDirectory implements AutoCloseable {
  interface Listener {
    void offer(JSONObject pair, Runnable ready) throws Exception;

    void stopped();
  }

  final OkHttpClient client;
  private final String base;
  private final Listener result;
  private final Handler timer = new Handler(Looper.getMainLooper());
  private final SecureRandom random = new SecureRandom();
  private final ArrayDeque<Long> attempts = new ArrayDeque<>();
  private WebSocket socket;
  private volatile String code = "";
  private boolean closed;
  private int retries;

  PinDirectory(String base, OkHttpClient client, Listener result) {
    this.base = base;
    this.client = client;
    this.result = result;
  }

  String code() {
    return code;
  }

  static String b64(byte[] value) {
    return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
  }

  static String hex(byte[] value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value) out.append(String.format(Locale.ROOT, "%02x", b));
    return out.toString();
  }

  static JSONObject derive(KeyPair local, byte[] encoded) throws Exception {
    PublicKey peer = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
    KeyAgreement ecdh = KeyAgreement.getInstance("ECDH");
    ecdh.init(local.getPrivate());
    ecdh.doPhase(peer, true);
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
    byte[] prk = mac.doFinal(ecdh.generateSecret());
    mac.init(new SecretKeySpec(prk, "HmacSHA256"));
    byte[] info = "remote-control/pair/v1".getBytes(StandardCharsets.UTF_8);
    mac.update(info);
    byte[] first = mac.doFinal(new byte[] {1});
    mac.update(first);
    mac.update(info);
    byte[] second = mac.doFinal(new byte[] {2});
    byte[] output = ByteBuffer.allocate(64).put(first).put(second).array();
    return new JSONObject()
        .put("listen", b64(Arrays.copyOfRange(output, 0, 24)))
        .put("dial", b64(Arrays.copyOfRange(output, 24, 48)))
        .put("check", hex(Arrays.copyOfRange(output, 48, 51)).toUpperCase(Locale.ROOT));
  }

  synchronized void start() {
    if (closed) return;
    timer.removeCallbacksAndMessages(null);
    if (socket != null) socket.cancel();
    code = "";
    String next = String.format(Locale.ROOT, "%04d", random.nextInt(10000));
    socket =
        client.newWebSocket(
            new Request.Builder().url(base + "/v1/session").build(),
            new WebSocketListener() {
              final Set<Integer> pending = new HashSet<>();

              @Override
              public void onOpen(WebSocket ws, Response response) {
                try {
                  byte[] digest =
                      MessageDigest.getInstance("SHA-256")
                          .digest(
                              ("remote-control/pin/v1/" + next).getBytes(StandardCharsets.UTF_8));
                  ws.send(
                      new JSONObject()
                          .put("role", "host")
                          .put("room", hex(digest).substring(0, 32))
                          .toString());
                } catch (Exception e) {
                  ws.cancel();
                }
              }

              @Override
              public void onMessage(WebSocket ws, String text) {
                synchronized (PinDirectory.this) {
                  if (closed || socket != ws) return;
                  try {
                    JSONObject m = new JSONObject(text);
                    String type = m.getString("t");
                    if (type.equals("ready")) {
                      code = next;
                      retries = 0;
                      timer.postDelayed(PinDirectory.this::start, 300000);
                    } else if (type.equals("unavailable") && ++retries < 8) start();
                    else if (type.equals("join")) pending.add((int) m.getLong("id"));
                    else if (type.equals("left")) pending.remove((int) m.getLong("id"));
                  } catch (Exception e) {
                    ws.cancel();
                  }
                }
              }

              @Override
              public void onMessage(WebSocket ws, ByteString packet) {
                if (packet.size() != 95) return;
                ByteBuffer in = packet.asByteBuffer();
                int id = in.getInt();
                synchronized (PinDirectory.this) {
                  if (closed || socket != ws || !pending.remove(id)) return;
                  long now = SystemClock.elapsedRealtime();
                  while (!attempts.isEmpty() && now - attempts.peekFirst() > 60000)
                    attempts.removeFirst();
                  if (attempts.size() >= 8) {
                    drop(ws, id);
                    return;
                  }
                  attempts.addLast(now);
                }
                try {
                  byte[] encoded = new byte[in.remaining()];
                  in.get(encoded);
                  KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
                  generator.initialize(new ECGenParameterSpec("secp256r1"));
                  KeyPair keys = generator.generateKeyPair();
                  JSONObject pair = derive(keys, encoded);
                  byte[] response = keys.getPublic().getEncoded();
                  result.offer(
                      pair,
                      () ->
                          ws.send(
                              ByteString.of(
                                  ByteBuffer.allocate(4 + response.length)
                                      .putInt(id)
                                      .put(response)
                                      .array())));
                } catch (Exception e) {
                  drop(ws, id);
                }
              }

              @Override
              public void onFailure(WebSocket ws, Throwable e, Response r) {
                ended(ws);
              }

              @Override
              public void onClosing(WebSocket ws, int n, String why) {
                ws.close(n, null);
                ended(ws);
              }
            });
  }

  private void ended(WebSocket ws) {
    synchronized (this) {
      if (closed || socket != ws) return;
      code = "";
    }
    result.stopped();
  }

  private static void drop(WebSocket ws, int id) {
    try {
      ws.send(new JSONObject().put("t", "drop").put("id", Integer.toUnsignedLong(id)).toString());
    } catch (Exception ignored) {
    }
  }

  public synchronized void close() {
    closed = true;
    code = "";
    timer.removeCallbacksAndMessages(null);
    if (socket != null) socket.cancel();
  }
}
