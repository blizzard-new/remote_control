package org.remotecontrol.share;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneGestureTest {
  @Test
  public void approvedPointerReachesAnotherAppsButton() throws Exception {
    Instrumentation inst = InstrumentationRegistry.getInstrumentation();
    Context ctx = inst.getTargetContext();
    Configurator config = Configurator.getInstance();
    int previous = config.getUiAutomationFlags();
    config.setUiAutomationFlags(previous | UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    UiDevice ui = UiDevice.getInstance(inst);
    Object controller = new Object();
    try {
      ctx.startActivity(
          new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      UiObject2 service = ui.wait(Until.findObject(By.text("遠端桌面觸控操作")), 5000);
      if (service == null) {
        UiScrollable scroll = new UiScrollable(new UiSelector().scrollable(true));
        scroll.scrollIntoView(new UiSelector().text("遠端桌面觸控操作"));
        service = ui.wait(Until.findObject(By.text("遠端桌面觸控操作")), 5000);
      }
      assertNotNull("Remote Control in system Accessibility settings", service);
      service.click();
      UiObject2 enable =
          ui.wait(Until.findObject(By.res("com.android.settings", "switch_widget")), 3000);
      if (enable == null)
        enable = ui.wait(Until.findObject(By.clazz("android.widget.Switch")), 3000);
      if (enable == null) enable = ui.wait(Until.findObject(By.textStartsWith("Use ")), 3000);
      assertNotNull("System service enable switch", enable);
      enable.click();
      UiObject2 allow = ui.wait(Until.findObject(By.res("android", "button1")), 3000);
      if (allow == null)
        allow =
            ui.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)allow"))), 3000);
      if (allow != null) allow.click();
      // getDisplayHeight may exclude system bars. Production uses the captured display pixels.
      android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
      ctx.getSystemService(android.view.WindowManager.class)
          .getDefaultDisplay()
          .getRealMetrics(metrics);
      PhoneControl.captureSize(metrics.widthPixels, metrics.heightPixels);
      long deadline = SystemClock.elapsedRealtime() + 10000;
      while (!PhoneControl.available() && SystemClock.elapsedRealtime() < deadline)
        SystemClock.sleep(80);
      assertTrue("Android connected the user-enabled service", PhoneControl.available());
      ctx.startActivity(
          new Intent()
              .setClassName(
                  inst.getContext().getPackageName(),
                  "org.remotecontrol.share.test.GesturePadActivity")
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
      UiObject2 pad = ui.wait(Until.findObject(By.text("等待電腦點擊")), 5000);
      assertNotNull(pad);
      ui.waitForIdle();
      Rect rect = pad.getVisibleBounds();
      double x = (double) rect.centerX() / (metrics.widthPixels - 1),
          y = (double) rect.centerY() / (metrics.heightPixels - 1);
      JSONObject down =
          new JSONObject()
              .put("kind", "button")
              .put("button", 0)
              .put("down", true)
              .put("x", x)
              .put("y", y);
      JSONObject up = new JSONObject(down.toString()).put("down", false);
      PhoneControl.input(controller, down);
      PhoneControl.input(controller, up);
      assertFalse(ui.wait(Until.hasObject(By.text("收到遠端點擊")), 300));
      InternetPairTest.exerciseHost(
          true,
          (socket, viewKey) -> {
            InternetPairTest.sendEvent(socket, viewKey, 1, down);
            InternetPairTest.sendEvent(socket, viewKey, 2, up);
            assertTrue(
                "Encrypted remote click dispatched to the other app",
                ui.wait(Until.hasObject(By.text("收到遠端點擊")), 5000));
          });
      InternetPairTest.exerciseHost(true, (socket, viewKey) -> {
        InternetPairTest.sendEvent(socket, viewKey, 1, down);
        InternetPairTest.sendEvent(socket, viewKey, 2, up);
        assertTrue("Trusted controller resumed without another approval",
            ui.wait(Until.hasObject(By.text("收到第二次遠端點擊")), 5000));
      }, true);
    } finally {
      PhoneControl.release(controller);
      PhoneControl.captureSize(0, 0);
      ui.pressHome();
      config.setUiAutomationFlags(previous);
    }
  }
}
