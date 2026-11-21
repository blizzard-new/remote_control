package org.remotecontrol.share;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import static org.junit.Assert.*;

public class ScreenServerTest {
    private ScreenServer server;
    private SSLContext tls;

    @Before public void start() throws Exception {
        Path dir = Files.createTempDirectory("android-screen-test");
        Path keyFile = dir.resolve("identity.p12");
        String password = "local-test-only";
        try {
            String command = System.getProperty("os.name").startsWith("Windows") ? "keytool.exe" : "keytool";
            Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", command).toString(),
                    "-genkeypair", "-alias", "host", "-keystore", keyFile.toString(), "-storetype", "PKCS12",
                    "-storepass", password, "-keyalg", "EC", "-dname", "CN=localhost", "-ext", "SAN=IP:127.0.0.1")
                    .redirectErrorStream(true).start();
            byte[] output = process.getInputStream().readAllBytes();
            assertEquals(new String(output, StandardCharsets.UTF_8), 0, process.waitFor());
            KeyStore keys = KeyStore.getInstance("PKCS12");
            try (InputStream in = Files.newInputStream(keyFile)) { keys.load(in, password.toCharArray()); }
            KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            km.init(keys, password.toCharArray());
            TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trust.init(keys);
            tls = SSLContext.getInstance("TLS");
            tls.init(km.getKeyManagers(), trust.getTrustManagers(), null);
        } finally {
            Files.deleteIfExists(keyFile);
            Files.deleteIfExists(dir);
        }
        server = new ScreenServer(InetAddress.getByName("127.0.0.1"), tls);
        server.start(() -> fail("listener unexpectedly stopped"));
    }

    @After public void stop() { if (server != null) server.close(); }

    private HttpsURLConnection request(String path) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(server.url() + path).openConnection();
        connection.setSSLSocketFactory(tls.getSocketFactory());
        connection.setConnectTimeout(2_000);
        connection.setReadTimeout(4_000);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }

    private HttpsURLConnection pair(String code) throws Exception {
        HttpsURLConnection connection = request("/pair");
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        connection.setDoOutput(true);
        try (var out = connection.getOutputStream()) { out.write(("code=" + code).getBytes(StandardCharsets.US_ASCII)); }
        return connection;
    }

    @Test public void pairingGatesFramesAndEndingSessionRevokesCookie() throws Exception {
        HttpsURLConnection login = request("/");
        String form = new String(login.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(form.contains("/pair"));
        assertFalse(form.contains(server.code()));
        login.disconnect();
        HttpsURLConnection anonymous = request("/screen.mjpeg");
        assertEquals(303, anonymous.getResponseCode());
        anonymous.disconnect();
        HttpsURLConnection wrongCode = pair("12345");
        assertEquals(403, wrongCode.getResponseCode());
        wrongCode.disconnect();

        HttpsURLConnection accepted = pair(server.code());
        assertEquals(303, accepted.getResponseCode());
        String cookie = accepted.getHeaderField("Set-Cookie");
        assertTrue(cookie.contains("Secure; HttpOnly; SameSite=Strict"));
        cookie = cookie.split(";")[0];
        accepted.disconnect();
        byte[] image = new byte[]{(byte) 0xff, (byte) 0xd8, 0x13, (byte) 0xff, (byte) 0xd9};
        server.publish(image);
        HttpsURLConnection[] viewers = new HttpsURLConnection[2];
        for (int i = 0; i < viewers.length; i++) {
            viewers[i] = request("/screen.mjpeg");
            viewers[i].setRequestProperty("Cookie", cookie);
            assertEquals(200, viewers[i].getResponseCode());
            assertTrue(viewers[i].getContentType().startsWith("multipart/x-mixed-replace"));
            // Read the MIME headers without consuming or converting any JPEG bytes.
            InputStream in = viewers[i].getInputStream();
            String expected = "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\n";
            assertEquals(expected, new String(in.readNBytes(expected.length()), StandardCharsets.US_ASCII));
            assertArrayEquals(image, in.readNBytes(image.length));
            assertArrayEquals(new byte[]{13, 10}, in.readNBytes(2));
        }
        assertEquals(2, server.viewers());
        String old = server.code();
        server.close();
        for (HttpsURLConnection viewer : viewers) {
            assertEquals(-1, viewer.getInputStream().read());
            viewer.disconnect();
        }
        server = new ScreenServer(InetAddress.getByName("127.0.0.1"), tls);
        server.start(() -> fail("listener unexpectedly stopped"));
        assertNotEquals(old, server.code());
        HttpsURLConnection stale = request("/view");
        stale.setRequestProperty("Cookie", cookie);
        assertEquals(303, stale.getResponseCode());
        stale.disconnect();
    }
}
