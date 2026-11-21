package org.remotecontrol.share;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.graphics.Path;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import org.json.JSONObject;

/** Gestures are accepted for one locally approved peer during full-screen capture. */
public final class PhoneControl extends AccessibilityService {
  private static PhoneControl service;
  private static Object controller;
  private static int captureWidth, captureHeight;
  private final Handler main = new Handler(Looper.getMainLooper());
  private String foreground = "";
  private float startX, startY;
  private long pressed;
  private double wheelX, wheelY;
  private float anchorX, anchorY;
  private boolean wheelScheduled;
  private long nextWheel;
  private final Runnable scroll =
      () -> {
        synchronized (PhoneControl.class) {
          wheelScheduled = false;
          if (controller != null && service == this && userScreen() && fullDisplay()) {
            DisplayMetrics m = metrics();
            float dx =
                (float) Math.max(-m.widthPixels * .45, Math.min(m.widthPixels * .45, wheelX * 3));
            float dy =
                (float) Math.max(-m.heightPixels * .45, Math.min(m.heightPixels * .45, wheelY * 3));
            float endX = Math.max(1, Math.min(m.widthPixels - 2, anchorX - dx));
            float endY = Math.max(1, Math.min(m.heightPixels - 2, anchorY - dy));
            gesture(anchorX, anchorY, endX, endY, 150);
            nextWheel = SystemClock.uptimeMillis() + 160;
          }
          wheelX = wheelY = 0;
        }
      };

  @Override
  public void onServiceConnected() {
    synchronized (PhoneControl.class) {
      service = this;
    }
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent e) {
    if (e.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        && e.getPackageName() != null) foreground = e.getPackageName().toString();
  }

  @Override
  public void onInterrupt() {
    releaseAll();
  }

  @Override
  public void onDestroy() {
    synchronized (PhoneControl.class) {
      if (service == this) {
        releaseAll();
        service = null;
      }
    }
    super.onDestroy();
  }

  static synchronized void captureSize(int w, int h) {
    captureWidth = w;
    captureHeight = h;
  }

  static synchronized boolean enabled() {
    return service != null;
  }

  static synchronized boolean available() {
    if (service == null || controller != null || captureWidth <= 0) return false;
    return service.fullDisplay();
  }

  private boolean fullDisplay() {
    DisplayMetrics m = metrics();
    return m.widthPixels == captureWidth && m.heightPixels == captureHeight;
  }

  static synchronized boolean claim(Object peer) {
    if (!available()) return false;
    controller = peer;
    return true;
  }

  static synchronized void release(Object peer) {
    if (controller == peer) releaseAll();
  }

  static synchronized void releaseAll() {
    controller = null;
    if (service != null) {
      service.pressed = 0;
      service.wheelScheduled = false;
      service.wheelX = service.wheelY = 0;
      service.nextWheel = 0;
      service.main.removeCallbacksAndMessages(null);
    }
  }

  static synchronized void input(Object peer, JSONObject event) {
    if (service == null || controller != peer || event == null) return;
    if ("move".equals(event.optString("kind"))) return;
    PhoneControl target = service;
    target.main.post(
        () -> {
          synchronized (PhoneControl.class) {
            if (service == target && controller == peer) target.apply(event);
          }
        });
  }

  private DisplayMetrics metrics() {
    DisplayMetrics m = new DisplayMetrics();
    getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(m);
    return m;
  }

  private boolean userScreen() {
    KeyguardManager lock = getSystemService(KeyguardManager.class);
    if (lock == null
        || lock.isKeyguardLocked()
        || foreground.isEmpty()
        || foreground.equals(getPackageName())) return false;
    return !(foreground.equals("android")
        || foreground.equals("com.android.systemui")
        || foreground.contains("permissioncontroller")
        || foreground.contains("packageinstaller")
        || foreground.equals("com.android.settings")
        || foreground.endsWith(".settings"));
  }

  private void apply(JSONObject e) {
    if (!userScreen() || !fullDisplay()) {
      pressed = 0;
      return;
    }
    String kind = e.optString("kind");
    if (kind.equals("reset")) {
      pressed = 0;
      return;
    }
    if (kind.equals("key") && e.optBoolean("down")) {
      String key = e.optString("code");
      if (key.equals("Escape") || key.equals("Backspace")) performGlobalAction(GLOBAL_ACTION_BACK);
      else if (key.equals("Home")) performGlobalAction(GLOBAL_ACTION_HOME);
      return;
    }
    if (!kind.equals("button") && !kind.equals("wheel")) return;
    DisplayMetrics m = metrics();
    double nx = e.optDouble("x"), ny = e.optDouble("y");
    if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return;
    float x = (float) (nx * (m.widthPixels - 1)), y = (float) (ny * (m.heightPixels - 1));
    if (kind.equals("button") && e.optInt("button", -1) == 0) {
      if (e.optBoolean("down")) {
        startX = x;
        startY = y;
        pressed = SystemClock.uptimeMillis();
      } else if (pressed != 0) {
        long duration = SystemClock.uptimeMillis() - pressed;
        pressed = 0;
        gesture(startX, startY, x, y, Math.min(1500, Math.max(60, duration)));
      }
    } else if (kind.equals("wheel")) {
      double dx = e.optDouble("dx", 0), dy = e.optDouble("dy", 0);
      if (!Double.isFinite(dx) || !Double.isFinite(dy) || (dx == 0 && dy == 0)) return;
      anchorX = x;
      anchorY = y;
      wheelX += dx;
      wheelY += dy;
      if (!wheelScheduled) {
        wheelScheduled = true;
        main.postAtTime(scroll, Math.max(SystemClock.uptimeMillis() + 20, nextWheel));
      }
    }
  }

  private void gesture(float x, float y, float endX, float endY, long ms) {
    Path path = new Path();
    path.moveTo(x, y);
    if (x != endX || y != endY) path.lineTo(endX, endY);
    dispatchGesture(
        new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, ms))
            .build(),
        null,
        null);
  }
}
