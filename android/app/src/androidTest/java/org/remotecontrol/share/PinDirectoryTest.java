package org.remotecontrol.share;

import static org.junit.Assert.*;

import android.util.Base64;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.util.Arrays;
import java.util.concurrent.*;
import okhttp3.*;
import okhttp3.mockwebserver.*;
import okhttp3.tls.*;
import okio.ByteString;
import org.json.JSONObject;
import org.junit.Test;

public class PinDirectoryTest {
  @Test public void pinResumeMatchesWebCryptoAndStopsAfterRevocation() throws Exception {
    PhoneDevices devices = new PhoneDevices(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext());
    String address = "https://test.invalid", challenge = "0123456789abcdef0123456789abcdef";
    JSONObject pair = new JSONObject().put("name","Mac").put("address",address)
        .put("listen","W8j9UP_0_5uoUbe2qUgE6tCuZinmkxsU").put("dial","a-uLqDClD9V4oTeBKaHTDHCFGbRn3kAA").put("grant","control");
    org.json.JSONArray offers = new org.json.JSONArray().put("OuiVkSRnEt65Nr7CF8ssxa3pZErzjbm03v_oteSfzZg");
    assertNotEquals("null", devices.update("save",pair.toString()));
    try {
      assertEquals("_iN3KDUUXBiloUvS__K6L2jjSh3U2K_F7tBkiUOSB5A", devices.resumeAnswer(offers,address,challenge));
      assertNull(devices.resumeAnswer(offers,address,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
      assertNull(devices.resumeAnswer(offers,"https://different.invalid",challenge));
    } finally { devices.update("forget",pair.toString()); }
    assertNull(devices.resumeAnswer(offers,address,challenge));
  }
  @Test
  public void androidAgreesWithWebCryptoOnDirectionalDeviceKeys() throws Exception {
    // Public test vector: P-256 private scalars 1 and 2. No production credentials.
    byte[] browserPub =
        Base64.decode(
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI/EdmmXgHd1UQ247QQCk9msafdDDbun2t5jzpgimeBLedInhz0Q==",
            Base64.DEFAULT);
    KeyFactory factory = KeyFactory.getInstance("EC");
    ECPublicKey browser = (ECPublicKey) factory.generatePublic(new X509EncodedKeySpec(browserPub));
    PrivateKey local =
        factory.generatePrivate(new ECPrivateKeySpec(BigInteger.ONE, browser.getParams()));
    JSONObject pair = PinDirectory.derive(new KeyPair(null, local), browserPub);
    assertEquals("W8j9UP_0_5uoUbe2qUgE6tCuZinmkxsU", pair.getString("listen"));
    assertEquals("a-uLqDClD9V4oTeBKaHTDHCFGbRn3kAA", pair.getString("dial"));
    assertEquals("CFC11B", pair.getString("check"));
  }

  @Test
  public void phoneAdvertisesFourDigitsAndAnswersEphemeralExchange() throws Exception {
    HeldCertificate cert =
        new HeldCertificate.Builder()
            .commonName("localhost")
            .addSubjectAlternativeName("localhost")
            .build();
    HandshakeCertificates serverTLS =
        new HandshakeCertificates.Builder().heldCertificate(cert).build();
    HandshakeCertificates clientTLS =
        new HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate()).build();
    OkHttpClient client =
        new OkHttpClient.Builder()
            .sslSocketFactory(clientTLS.sslSocketFactory(), clientTLS.trustManager())
            .build();
    LinkedBlockingQueue<WebSocket> sockets = new LinkedBlockingQueue<>();
    LinkedBlockingQueue<String> text = new LinkedBlockingQueue<>();
    LinkedBlockingQueue<ByteString> binary = new LinkedBlockingQueue<>();
    LinkedBlockingQueue<JSONObject> offers = new LinkedBlockingQueue<>();
    try (MockWebServer server = new MockWebServer()) {
      server.useHttps(serverTLS.sslSocketFactory(), false);
      server.enqueue(
          new MockResponse()
              .withWebSocketUpgrade(
                  new WebSocketListener() {
                    @Override
                    public void onOpen(WebSocket ws, Response r) {
                      sockets.add(ws);
                    }

                    @Override
                    public void onMessage(WebSocket ws, String message) {
                      text.add(message);
                    }

                    @Override
                    public void onMessage(WebSocket ws, ByteString message) {
                      binary.add(message);
                    }
                  }));
      server.start();
      try (PinDirectory directory =
          new PinDirectory(
              server.url("/").toString().replaceFirst("/$", ""),
              client,
              new PinDirectory.Listener() {
                public void offer(JSONObject pair, Runnable ready) {
                  offers.add(pair);
                  ready.run();
                }

                public void stopped() {}
              })) {
        directory.start();
        WebSocket ws = sockets.poll(8, TimeUnit.SECONDS);
        assertNotNull(ws);
        String room = new JSONObject(text.poll(5, TimeUnit.SECONDS)).getString("room");
        ws.send("{\"t\":\"ready\"}");
        for (int i = 0; i < 80 && directory.code().isEmpty(); i++) Thread.sleep(50);
        assertTrue(directory.code().matches("[0-9]{4}"));
        byte[] expected =
            MessageDigest.getInstance("SHA-256")
                .digest(
                    ("remote-control/pin/v1/" + directory.code()).getBytes(StandardCharsets.UTF_8));
        assertEquals(PinDirectory.hex(expected).substring(0, 32), room);
        KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
        gen.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair viewer = gen.generateKeyPair();
        byte[] pub = viewer.getPublic().getEncoded();
        ws.send("{\"t\":\"join\",\"id\":7}");
        ws.send(ByteString.of(ByteBuffer.allocate(4 + pub.length).putInt(7).put(pub).array()));
        JSONObject phone = offers.poll(5, TimeUnit.SECONDS);
        assertNotNull(phone);
        byte[] reply = binary.poll(5, TimeUnit.SECONDS).toByteArray();
        assertEquals(7, ByteBuffer.wrap(reply).getInt());
        JSONObject local = PinDirectory.derive(viewer, Arrays.copyOfRange(reply, 4, reply.length));
        assertEquals(local.getString("listen"), phone.getString("listen"));
        assertEquals(local.getString("check"), phone.getString("check"));
      }
    } finally {
      client.connectionPool().evictAll();
      client.dispatcher().executorService().shutdown();
    }
  }
}
