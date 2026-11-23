package org.remotecontrol.share;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Build;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
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
    SecureRandom random = new SecureRandom();
    byte[] seed = new byte[24], reverse = new byte[24];
    random.nextBytes(seed);
    random.nextBytes(reverse);
    ProjectionViewer viewer = new ProjectionViewer(seed);
    PhoneDevices contacts = new PhoneDevices(context);
    JSONObject contact =
        new JSONObject()
            .put("listen", PinDirectory.b64(seed))
            .put("dial", PinDirectory.b64(reverse))
            .put("platform", "Darwin")
            .put("name", "Mac")
            .put("grant", "view");
    SharedPreferences prefs = context.getSharedPreferences("ShareActivity", Context.MODE_PRIVATE);
    String oldAddress = prefs.getString("relay", null);
    try (MockWebServer relay = new MockWebServer()) {
      relay.useHttps(tls.sslSocketFactory(), false);
      relay.setDispatcher(
          new okhttp3.mockwebserver.Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
              return new MockResponse().withWebSocketUpgrade(viewer);
            }
          });
      relay.start();
      String address = relay.url("/").toString().replaceFirst("/$", "");
      prefs.edit().putString("relay", address).commit();
      contact.put("address", address);
      assertNotEquals("null", contacts.update("save", contact.toString()));
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
        String registration = viewer.pins.poll(8, TimeUnit.SECONDS);
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
        assertEquals("projection", viewer.notices.poll(8, TimeUnit.SECONDS).getString("reason"));
        assertTrue(viewer.images.isEmpty());
        ui.findObject(By.text("開放整個螢幕連線")).click();
        UiObject2 consent = ui.wait(Until.findObject(By.res("android", "button1")), 8000);
        if (consent == null)
          consent = ui.wait(Until.findObject(By.pkg("com.android.systemui")
              .text(java.util.regex.Pattern.compile("(?i)(start( now| recording| sharing)?|share screen)"))), 5000);
        assertNotNull("Android projection consent", consent);
        assertEquals("com.android.systemui", consent.getApplicationPackage());
        consent.click();
        long end = SystemClock.elapsedRealtime() + 10000;
        while (!preview.sharing() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(80);
        assertSame(preview, CaptureService.online);
        assertTrue(preview.sharing());
        assertEquals(code, CaptureService.online.invitation());
        assertEquals("approved", viewer.notices.poll(8, TimeUnit.SECONDS).getString("t"));
        context.startActivity(
            new Intent()
                .setClassName(
                    inst.getContext().getPackageName(),
                    "org.remotecontrol.share.test.GesturePadActivity")
                .putExtra("colorPattern", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        File fixture = new File(context.getCacheDir(), "verified-phone-screen.jpg");
        android.util.DisplayMetrics metrics = CaptureService.screenMetrics(context);
        int sourceEdge = Math.max(metrics.widthPixels, metrics.heightPixels);
        visiblePhoneFrame(viewer, Math.min(960, sourceEdge));
        viewer.quality(3840, 60);
        byte[] frame = visiblePhoneFrame(viewer, Math.min(3840, sourceEdge));
        if (sourceEdge >= 1280 && Math.min(metrics.widthPixels, metrics.heightPixels) >= 800)
          assertTrue("Detailed mobile image traversed multiple encrypted relay packets", viewer.receivedParts);
        try (FileOutputStream file = new FileOutputStream(fixture)) {
          file.write(frame);
        }
      } finally {
        context.stopService(new Intent(context, CaptureService.class));
        long end = SystemClock.elapsedRealtime() + 5000;
        while (CaptureService.status.running && SystemClock.elapsedRealtime() < end)
          SystemClock.sleep(50);
        PhoneShare.releasePreview(preview);
      }
    } finally {
      contacts.update("forget", contact.toString());
      prefs.edit().putString("relay", oldAddress).commit();
      ui.pressHome();
    }
  }

  private static byte[] visiblePhoneFrame(ProjectionViewer viewer, int expectedEdge) throws InterruptedException {
    long deadline = SystemClock.elapsedRealtime() + 18000;
    while (SystemClock.elapsedRealtime() < deadline) {
      byte[] frame = viewer.images.poll(500, TimeUnit.MILLISECONDS);
      if (frame == null) continue;
      Bitmap image = BitmapFactory.decodeByteArray(frame, 0, frame.length);
      if (image == null) continue;
      try {
        if (Math.max(image.getWidth(), image.getHeight()) != expectedEdge) continue;
        int left = image.getPixel(image.getWidth() / 4, image.getHeight() / 2);
        int right = image.getPixel(3 * image.getWidth() / 4, image.getHeight() / 2);
        if (Color.green(left) > 160
            && Color.red(left) < 65
            && Color.red(right) > 160
            && Color.green(right) < 85) return frame;
      } finally {
        image.recycle();
      }
    }
    throw new AssertionError(
        "The viewer never received both visible colors of the projected Android app");
  }
}
