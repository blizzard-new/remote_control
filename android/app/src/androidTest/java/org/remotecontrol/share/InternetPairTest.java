package org.remotecontrol.share;

import static org.junit.Assert.*;

import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.*;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;
import okio.ByteString;
import org.json.JSONObject;
import org.junit.Test;

public class InternetPairTest {
  private static final java.nio.charset.Charset UTF8 = StandardCharsets.UTF_8;

  private static byte[] mac(byte[] key, byte[] data) throws Exception {
    Mac h = Mac.getInstance("HmacSHA256");
    h.init(new SecretKeySpec(key, "HmacSHA256"));
    return h.doFinal(data);
  }

  private static byte[] crypt(int mode, byte[] key, int n, byte[] message) throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(
        mode,
        new SecretKeySpec(key, "AES"),
        new GCMParameterSpec(128, ByteBuffer.allocate(12).putLong(0).putInt(n).array()));
    return c.doFinal(message);
  }

  interface Connected {
    void run(WebSocket ws, byte[] viewKey) throws Exception;
  }

  static void sendEvent(WebSocket ws, byte[] key, int sequence, JSONObject event) throws Exception {
    JSONObject input = new JSONObject().put("t", "input").put("event", event);
    byte[] packet = crypt(Cipher.ENCRYPT_MODE, key, sequence, ("\001" + input).getBytes(UTF8));
    ws.send(ByteString.of(ByteBuffer.allocate(4 + packet.length).putInt(7).put(packet).array()));
  }

  @Test
  public void androidHostAuthenticatesAndSendsFramesOnlyAfterConsent() throws Exception {
    exerciseHost(false, (ws, key) -> {});
  }

  @Test public void trustedViewerReconnectsWithItsSavedAccessAndNegotiatesVideo() throws Exception {
    exerciseHost(false, (ws,key) -> {}, true);
  }

  static void exerciseHost(boolean control, Connected connected) throws Exception {
    exerciseHost(control,connected,false);
  }
  static void exerciseHost(boolean control, Connected connected, boolean trusted) throws Exception {
    HeldCertificate cert =
        new HeldCertificate.Builder()
            .commonName("localhost")
            .addSubjectAlternativeName("localhost")
            .build();
    HandshakeCertificates serverTLS =
        new HandshakeCertificates.Builder().heldCertificate(cert).build();
    HandshakeCertificates clientTLS =
        new HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate()).build();
    LinkedBlockingQueue<String> text = new LinkedBlockingQueue<>();
    LinkedBlockingQueue<ByteString> binary = new LinkedBlockingQueue<>();
    LinkedBlockingQueue<WebSocket> sockets = new LinkedBlockingQueue<>();
    try (MockWebServer server = new MockWebServer()) {
      server.useHttps(serverTLS.sslSocketFactory(), false);
      server.enqueue(
          new MockResponse()
              .withWebSocketUpgrade(
                  new WebSocketListener() {
                    @Override
                    public void onOpen(WebSocket ws, Response response) {
                      sockets.add(ws);
                    }

                    @Override
                    public void onMessage(WebSocket ws, String msg) {
                      text.add(msg);
                    }

                    @Override
                    public void onMessage(WebSocket ws, ByteString msg) {
                      binary.add(msg);
                    }

                    @Override
                    public void onClosing(WebSocket ws, int code, String reason) {
                      ws.close(code, null);
                    }
                  }));
      server.start();
      OkHttpClient client =
          new OkHttpClient.Builder()
              .sslSocketFactory(clientTLS.sslSocketFactory(), clientTLS.trustManager())
              .build();
      try (InternetHost host =
          new InternetHost(server.url("/").toString(), ignored -> {}, client)) {
        if (trusted) host.grant = "view";
        host.start();
        WebSocket ws = sockets.poll(8, TimeUnit.SECONDS);
        assertNotNull(ws);
        assertEquals("host", new JSONObject(text.poll(5, TimeUnit.SECONDS)).getString("role"));
        ws.send("{\"t\":\"ready\"}");
        for (int i = 0; i < 80 && host.invitation().isEmpty(); i++) Thread.sleep(50);
        String[] invitation = host.invitation().split("\\.");
        assertEquals("rc1", invitation[0]);
        byte[] seed = Base64.decode(invitation[2], Base64.URL_SAFE);
        ws.send("{\"t\":\"join\",\"id\":7,\"nonce\":\"00000000000000000000000000000000\"}");
        String nonce = new JSONObject(text.poll(5, TimeUnit.SECONDS)).getString("nonce");
        byte[] salt = new byte[32];
        for (int i = 0; i < 16; i++)
          salt[i] = (byte) Integer.parseInt(nonce.substring(2 * i, 2 * i + 2), 16);
        byte[] prk = mac(salt, seed),
            view = mac(prk, "remote-control/v1/view\001".getBytes(UTF8)),
            share = mac(prk, "remote-control/v1/share\001".getBytes(UTF8));
        byte[] req =
            crypt(
                Cipher.ENCRYPT_MODE,
                view,
                0,
                ("\001" + new JSONObject().put("t","request").put("name","tablet")
                    .put("avc",trusted).put("fps",60).put("edge",1280)).getBytes(UTF8));
        ws.send(ByteString.of(ByteBuffer.allocate(4 + req.length).putInt(7).put(req).array()));
        if (trusted) {
          byte[] ready = binary.poll(5,TimeUnit.SECONDS).toByteArray();
          byte[] data = crypt(Cipher.DECRYPT_MODE,share,0,Arrays.copyOfRange(ready,4,ready.length));
          JSONObject accepted = new JSONObject(new String(data,1,data.length-1,UTF8));
          assertEquals("approved",accepted.getString("t"));
          assertFalse(accepted.getBoolean("control"));
          assertTrue(host.pending().isEmpty());
          assertEquals(128060,host.codecProfile());
          host.video(false,new byte[]{0,5});
          assertNull(binary.poll(100,TimeUnit.MILLISECONDS));
          host.video(true,new byte[]{1,5});
          byte[] keyframe=binary.poll(5,TimeUnit.SECONDS).toByteArray();
          assertArrayEquals(new byte[]{3,1,5},crypt(Cipher.DECRYPT_MODE,share,1,Arrays.copyOfRange(keyframe,4,keyframe.length)));
          return;
        }
        for (int i = 0; i < 80 && host.pending().isEmpty(); i++) Thread.sleep(50);
        assertEquals("tablet", host.pending().get(7));
        byte[] frame = {4, 1, 2, 3};
        host.publish(frame);
        assertNull(binary.poll(200, TimeUnit.MILLISECONDS));
        host.decide(7, true, control, true);
        byte[] approved = binary.poll(5, TimeUnit.SECONDS).toByteArray();
        byte[] clear =
            crypt(Cipher.DECRYPT_MODE, share, 0, Arrays.copyOfRange(approved, 4, approved.length));
        assertEquals(
            "approved",
            new JSONObject(new String(clear, 1, clear.length - 1, UTF8)).getString("t"));
        assertEquals(
            control,
            new JSONObject(new String(clear, 1, clear.length - 1, UTF8)).getBoolean("control"));
        connected.run(ws, view);
        byte[] packet = binary.poll(5, TimeUnit.SECONDS).toByteArray();
        assertArrayEquals(
            new byte[] {2, 4, 1, 2, 3},
            crypt(Cipher.DECRYPT_MODE, share, 1, Arrays.copyOfRange(packet, 4, packet.length)));
      }
    }
  }
}
