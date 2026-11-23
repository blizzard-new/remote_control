package org.remotecontrol.share;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import okhttp3.mockwebserver.*;
import okhttp3.tls.*;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneCodeTest {
  @Test
  public void dashboardCodeSurvivesAndroidProjectionConsent() throws Exception {
    Instrumentation inst = InstrumentationRegistry.getInstrumentation();
    Context context = inst.getTargetContext();
    UiDevice ui = UiDevice.getInstance(inst);
    HeldCertificate cert =
        new HeldCertificate.Builder()
            .commonName("localhost")
            .addSubjectAlternativeName("localhost")
            .build();
    HandshakeCertificates tls = new HandshakeCertificates.Builder().heldCertificate(cert).build();
    HandshakeCertificates trust =
        new HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate()).build();
    LinkedBlockingQueue<String> registrations = new LinkedBlockingQueue<>();
    SharedPreferences prefs = context.getSharedPreferences("ShareActivity", Context.MODE_PRIVATE);
    String oldAddress = prefs.getString("relay", null);
    try (MockWebServer relay = new MockWebServer()) {
      relay.useHttps(tls.sslSocketFactory(), false);
      relay.enqueue(
          new MockResponse()
              .withWebSocketUpgrade(
                  new WebSocketListener() {
                    @Override
                    public void onMessage(WebSocket ws, String registration) {
                      registrations.add(registration);
                      ws.send("{\"t\":\"ready\"}");
                    }

                    @Override
                    public void onClosing(WebSocket ws, int code, String reason) {
                      ws.close(code, null);
                    }
                  }));
      relay.start();
      String address = relay.url("/").toString().replaceFirst("/$", "");
      prefs.edit().putString("relay", address).commit();
      PhoneShare preview =
          PhoneShare.prepare(
              context,
              address,
              () ->
                  new OkHttpClient.Builder()
                      .sslSocketFactory(trust.sslSocketFactory(), trust.trustManager())
                      .build());
      try {
        if (Build.VERSION.SDK_INT >= 33)
          inst.getUiAutomation()
              .grantRuntimePermission(
                  context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
        Intent home =
            context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        home.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(home);
        UiObject2 codeButton = ui.wait(Until.findObject(By.text("我的手機連線碼")), 12000);
        assertNotNull("Phone code on the device directory", codeButton);
        codeButton.click();
        String registration = registrations.poll(8, TimeUnit.SECONDS);
        assertNotNull(registration);
        UiObject2 label = ui.wait(Until.findObject(By.textContains("手機連線碼　")), 8000);
        assertNotNull(label);
        String code = preview.invitation();
        assertTrue(code.matches("[0-9]{4}"));
        assertTrue(label.getText().contains(code));
        byte[] digest =
            MessageDigest.getInstance("SHA-256")
                .digest(("remote-control/pin/v1/" + code).getBytes(StandardCharsets.UTF_8));
        assertEquals(
            PinDirectory.hex(digest).substring(0, 32),
            new JSONObject(registration).getString("room"));
        assertFalse(CaptureService.status.running);
        assertFalse(preview.sharing());
        ui.findObject(By.text("開放整個螢幕連線")).click();
        UiObject2 consent = ui.wait(Until.findObject(By.res("android", "button1")), 8000);
        assertNotNull("Android projection consent", consent);
        assertEquals("com.android.systemui", consent.getApplicationPackage());
        consent.click();
        long end = SystemClock.elapsedRealtime() + 10000;
        while (!preview.sharing() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(80);
        assertSame(preview, CaptureService.online);
        assertTrue(preview.sharing());
        assertEquals(code, CaptureService.online.invitation());
      } finally {
        context.stopService(new Intent(context, CaptureService.class));
        long end = SystemClock.elapsedRealtime() + 5000;
        while (CaptureService.status.running && SystemClock.elapsedRealtime() < end)
          SystemClock.sleep(50);
        PhoneShare.releasePreview(preview);
      }
    } finally {
      prefs.edit().putString("relay", oldAddress).commit();
      ui.pressHome();
    }
  }
}
