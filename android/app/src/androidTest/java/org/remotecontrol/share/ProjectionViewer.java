package org.remotecontrol.share;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import javax.crypto.Cipher;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * A previously paired desktop receives genuine projection frames over the phone's encrypted
 * channel.
 */
final class ProjectionViewer extends WebSocketListener {
  final LinkedBlockingQueue<String> pins = new LinkedBlockingQueue<>();
  final LinkedBlockingQueue<JSONObject> notices = new LinkedBlockingQueue<>();
  final ArrayBlockingQueue<byte[]> images = new ArrayBlockingQueue<>(2);
  private final byte[] seed;
  private final String room;
  private byte[] receiveKey;
  private int sequence;

  ProjectionViewer(byte[] seed) throws Exception {
    this.seed = seed;
    room = PinDirectory.hex(MessageDigest.getInstance("SHA-256").digest(seed)).substring(0, 32);
  }

  @Override
  public synchronized void onMessage(WebSocket ws, String text) {
    try {
      JSONObject message = new JSONObject(text);
      if (message.has("room")) {
        ws.send("{\"t\":\"ready\"}");
        if (!room.equals(message.getString("room"))) {
          pins.add(text);
          return;
        }
        ws.send("{\"t\":\"join\",\"id\":7,\"nonce\":\"00000000000000000000000000000000\"}");
      } else if ("hello".equals(message.optString("t"))) {
        byte[] salt = new byte[32];
        String nonce = message.getString("nonce");
        for (int i = 0; i < 16; i++)
          salt[i] = (byte) Integer.parseInt(nonce.substring(2 * i, 2 * i + 2), 16);
        byte[] root = InternetPairTest.mac(salt, seed);
        byte[] tx =
            InternetPairTest.mac(
                root, "remote-control/v1/view\001".getBytes(StandardCharsets.UTF_8));
        receiveKey =
            InternetPairTest.mac(
                root, "remote-control/v1/share\001".getBytes(StandardCharsets.UTF_8));
        JSONObject request =
            new JSONObject()
                .put("t", "request")
                .put("name", "Mac")
                .put("platform", "Darwin")
                .put("viewOnly", true)
                .put("avc", false);
        byte[] body =
            InternetPairTest.crypt(
                Cipher.ENCRYPT_MODE, tx, 0, ("\001" + request).getBytes(StandardCharsets.UTF_8));
        ws.send(ByteString.of(ByteBuffer.allocate(4 + body.length).putInt(7).put(body).array()));
      }
    } catch (Exception e) {
      throw new AssertionError(e);
    }
  }

  @Override
  public synchronized void onMessage(WebSocket ws, ByteString packet) {
    try {
      byte[] wire = packet.toByteArray();
      byte[] plain =
          InternetPairTest.crypt(
              Cipher.DECRYPT_MODE,
              receiveKey,
              sequence++,
              Arrays.copyOfRange(wire, 4, wire.length));
      if (plain[0] == 1)
        notices.add(new JSONObject(new String(plain, 1, plain.length - 1, StandardCharsets.UTF_8)));
      if (plain[0] == 2) {
        if (images.remainingCapacity() == 0) images.poll();
        images.offer(Arrays.copyOfRange(plain, 1, plain.length));
      }
    } catch (Exception e) {
      throw new AssertionError(e);
    }
  }

  @Override
  public void onClosing(WebSocket ws, int code, String reason) {
    ws.close(code, null);
  }
}
