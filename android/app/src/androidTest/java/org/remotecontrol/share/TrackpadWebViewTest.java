package org.remotecontrol.share;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Exercises ACTION_SCROLL -> renderer without relying on a particular keyboard vendor's event synthesis. */
public class TrackpadWebViewTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();

    @Test public void routesTrackpadAndApprovedScreenshotKeyToThePageOnce() throws Exception {
        Intent intent = new Intent(test.getTargetContext(), LanViewerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        DesktopViewerActivity activity = (DesktopViewerActivity) test.startActivitySync(intent);
        AtomicReference<TrackpadWebView> current = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        String origin = "https://trackpad.example";
        try {
            test.runOnMainSync(() -> {
                TrackpadWebView view = new TrackpadWebView(activity, origin);
                current.set(view);
                activity.setContentView(view);
                view.getSettings().setJavaScriptEnabled(true);
                view.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView web, String url) {
                        view.navigationCommitted(url);
                        ready.countDown();
                    }
                });
                view.loadDataWithBaseURL(origin + "/", """
                        <meta name="viewport" content="width=device-width,initial-scale=1">
                        <script>window.events=[];window.domWheel=0;addEventListener('wheel',()=>domWheel++);
                        window.screenshots=0;window.remoteControlAndroidScreenshot=()=>{screenshots++;return true}
                        window.remoteControlAndroidWheel=(...args)=>{events.push(args);return true}</script>
                        """, "text/html", "utf-8", origin + "/");
            });
            assertTrue("WebView did not load fixture", ready.await(8, TimeUnit.SECONDS));
            test.runOnMainSync(() -> {
                TrackpadWebView view = current.get();
                MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
                properties.toolType = MotionEvent.TOOL_TYPE_MOUSE;
                MotionEvent.PointerCoords axes = new MotionEvent.PointerCoords();
                axes.x = view.getWidth() / 2f;
                axes.y = view.getHeight() / 2f;
                axes.setAxisValue(MotionEvent.AXIS_VSCROLL, 0.125f);
                axes.setAxisValue(MotionEvent.AXIS_HSCROLL, 0.0625f);
                long now = SystemClock.uptimeMillis();
                MotionEvent wheel = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1,
                        new MotionEvent.PointerProperties[]{properties}, new MotionEvent.PointerCoords[]{axes},
                        0, 0, 1, 1, 0, 0, InputDevice.SOURCE_MOUSE, 0);
                try { assertTrue(view.onGenericMotionEvent(wheel)); } finally { wheel.recycle(); }
                KeyEvent printDown = new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SYSRQ);
                KeyEvent printUp = new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SYSRQ);
                assertFalse(view.routeScreenshotKey(printDown));
                view.setScreenshotEnabled(true);
                assertTrue(view.routeScreenshotKey(printDown));
                assertTrue(view.routeScreenshotKey(printUp));
                view.setScreenshotEnabled(false);
                assertFalse(view.routeScreenshotKey(printUp));
            });
            CountDownLatch checked = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            test.runOnMainSync(() -> current.get().evaluateJavascript("""
                    screenshots===1 && events.length===1 && domWheel===0 && events[0][0]===0.5 && events[0][1]===0.5 &&
                    events[0][2]>0 && events[0][2]<1 && events[0][3]<0 && events[0][3]>-1
                    """, value -> { result.set(value); checked.countDown(); }));
            assertTrue(checked.await(5, TimeUnit.SECONDS));
            assertEquals("true", result.get());
        } finally {
            test.runOnMainSync(() -> {
                if (current.get() != null) {
                    activity.setContentView(new android.view.View(activity));
                    current.get().destroy();
                }
                activity.finish();
            });
        }
    }
}
