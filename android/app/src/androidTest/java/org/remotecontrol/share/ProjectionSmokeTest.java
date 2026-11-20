package org.remotecontrol.share;

import android.Manifest;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import org.junit.Test;
import java.io.DataInputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import static org.junit.Assert.*;

/** Run on an English API 33 AOSP emulator connected to AndroidWifi. Presses the system's consent button. */
public final class ProjectionSmokeTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();
    private final UiDevice device = UiDevice.getInstance(instrumentation);

    private UiObject2 visible(androidx.test.uiautomator.BySelector selector) {
        UiObject2 object = device.wait(Until.findObject(selector), 10_000);
        assertNotNull("Missing visible control " + selector, object);
        return object;
    }

    @Test public void keystoreSignsThePrehashedEcdsaInputUsedByConscrypt() throws Exception {
        LocalIdentity identity = new LocalIdentity();
        String alias = identity.chooseEngineServerAlias("EC", null, null);
        assertNotNull(alias);
        byte[] transcript = MessageDigest.getInstance("SHA-256").digest("handshake".getBytes(StandardCharsets.US_ASCII));
        java.security.Signature signer = java.security.Signature.getInstance("NONEwithECDSA");
        signer.initSign(identity.getPrivateKey(alias));
        signer.update(transcript);
        byte[] signature = signer.sign();
        java.security.Signature verifier = java.security.Signature.getInstance("NONEwithECDSA");
        verifier.initVerify(identity.getCertificateChain(alias)[0].getPublicKey());
        verifier.update(transcript);
        assertTrue(verifier.verify(signature));
    }

    @Test public void consentPairViewStopAndRestartInBothFormats() throws Exception {
        if (Build.VERSION.SDK_INT >= 33) {
            instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(),
                    Manifest.permission.POST_NOTIFICATIONS);
        }
        try {
            String previous = null;
            for (boolean avc : new boolean[]{false, true}) {
                showHost();
                UiObject2 quality = visible(By.clazz("android.widget.CheckBox"));
                if (quality.isChecked() != avc) quality.click();
                visible(By.text("選擇分享畫面")).click();
                // API 33 displays one native confirmation. Never change AppOps or inject a consent token.
                UiObject2 consent = visible(By.res("android", "button1"));
                assertTrue("Expected the Android system projection prompt",
                        consent.getApplicationPackage().equals("com.android.systemui"));
                consent.click();
                long deadline = SystemClock.elapsedRealtime() + 20_000;
                String invitation = "";
                do {
                    invitation = CaptureService.status.text;
                    if (invitation.contains("https://")) break;
                    SystemClock.sleep(100);
                } while (SystemClock.elapsedRealtime() < deadline);
                assertTrue("Projection did not start: " + invitation, invitation.contains("https://"));
                String url = match(invitation, "https://[0-9.]+:[0-9]+");
                String fingerprint = match(invitation, "(?:[A-F0-9]{2}:){31}[A-F0-9]{2}");
                String code = match(invitation, "(?m)^[a-f0-9]{24}$");
                assertNotEquals(previous, code);
                previous = code;
                // Display actual UI other than the protected pairing screen.
                context.startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                visible(By.pkg("com.android.settings").depth(0));
                SSLContext tls = trustFingerprint(fingerprint);
                HttpsURLConnection pair = connect(url + "/pair", tls);
                String cookie;
                try {
                    pair.setRequestMethod("POST");
                    pair.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    pair.setDoOutput(true);
                    try (OutputStream out = pair.getOutputStream()) {
                        out.write(("code=" + code).getBytes(StandardCharsets.US_ASCII));
                    }
                    assertEquals(303, pair.getResponseCode());
                    cookie = pair.getHeaderField("Set-Cookie").split(";")[0];
                } finally { pair.disconnect(); }
                HttpsURLConnection live = connect(url + (avc ? "/screen.avc" : "/screen.mjpeg"), tls);
                try {
                    live.setRequestProperty("Cookie", cookie);
                    assertEquals(200, live.getResponseCode());
                    try (DataInputStream input = new DataInputStream(live.getInputStream())) {
                        if (avc) assertAvcKeyframe(input);
                        else assertVisibleJpeg(input);
                    }
                } finally { live.disconnect(); }
                showHost();
                // Scroll if compact display or font scaling has placed Stop below the fold.
                if (!device.hasObject(By.text("停止分享並中斷所有觀看者"))) {
                    device.swipe(device.getDisplayWidth() / 2, device.getDisplayHeight() * 9 / 10,
                            device.getDisplayWidth() / 2, device.getDisplayHeight() / 5, 15);
                }
                visible(By.text("停止分享並中斷所有觀看者")).click();
                long stopDeadline = SystemClock.elapsedRealtime() + 5_000;
                while (CaptureService.status.running && SystemClock.elapsedRealtime() < stopDeadline) SystemClock.sleep(50);
                assertFalse(CaptureService.status.running);
            }
        } finally {
            context.stopService(new Intent(context, CaptureService.class));
        }
    }

    private void showHost() {
        Intent show = new Intent(context, ShareActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        context.startActivity(show);
        device.waitForIdle();
    }

    private static String match(String text, String regex) {
        Matcher result = Pattern.compile(regex).matcher(text);
        assertTrue("Missing field in invitation", result.find());
        return result.group();
    }

    private static SSLContext trustFingerprint(String expected) throws Exception {
        X509TrustManager pin = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                throw new CertificateException();
            }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException();
                try {
                    chain[0].checkValidity();
                    byte[] hash = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                    StringBuilder actual = new StringBuilder();
                    for (byte b : hash) actual.append(String.format(Locale.ROOT, "%02X", b));
                    if (!actual.toString().equals(expected.replace(":", ""))) throw new CertificateException("Wrong host");
                } catch (java.security.NoSuchAlgorithmException e) { throw new AssertionError(e); }
            }
        };
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{pin}, null);
        return tls;
    }

    private static HttpsURLConnection connect(String target, SSLContext tls) throws Exception {
        URL url = new URL(target);
        HttpsURLConnection conn = (HttpsURLConnection) url.openConnection();
        conn.setSSLSocketFactory(tls.getSocketFactory());
        // The UI identifies the exact certificate. The self-signed identity has no IP SAN.
        conn.setHostnameVerifier((host, session) -> url.getHost().equals(host));
        conn.setConnectTimeout(5_000);
        conn.setReadTimeout(12_000);
        conn.setInstanceFollowRedirects(false);
        return conn;
    }

    private static void assertAvcKeyframe(DataInputStream input) throws Exception {
        int bytes = input.readInt();
        assertTrue(bytes > 0 && bytes <= AvcFrames.MAX_FRAME);
        input.readLong();
        assertEquals(1, input.readUnsignedByte());
        byte[] payload = new byte[bytes];
        input.readFully(payload);
        boolean sps = false, pps = false, idr = false;
        for (int i = 2; i + 1 < bytes; i++) {
            if (payload[i] != 1 || payload[i-1] != 0 || payload[i-2] != 0) continue;
            int type = payload[i+1] & 31;
            sps |= type == 7;
            pps |= type == 8;
            idr |= type == 5;
        }
        assertTrue("Encoder must deliver a decodable Annex-B keyframe", sps && pps && idr);
    }

    private static void assertVisibleJpeg(DataInputStream input) throws Exception {
        for (int i = 0; i < 24; i++) {
            assertEquals("--frame", input.readLine());
            assertEquals("Content-Type: image/jpeg", input.readLine());
            int length = Integer.parseInt(input.readLine().replace("Content-Length: ", ""));
            assertTrue(length > 0 && length < 6_000_000);
            assertEquals("", input.readLine());
            byte[] data = new byte[length];
            input.readFully(data);
            Bitmap frame = BitmapFactory.decodeByteArray(data, 0, length);
            assertNotNull(frame);
            try {
                int first = frame.getPixel(0, 0);
                for (int y = 0; y < frame.getHeight(); y += 8) {
                    for (int x = 0; x < frame.getWidth(); x += 8) {
                        if (frame.getPixel(x, y) != first) return;
                    }
                }
            } finally { frame.recycle(); }
            assertEquals("", input.readLine());
        }
        fail("Expected a non-uniform picture after opening Settings");
    }
}
