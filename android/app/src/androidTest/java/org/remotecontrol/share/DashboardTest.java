package org.remotecontrol.share;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Insets;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

public class DashboardTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();

    private WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    @Test public void launcherShowsDeviceListInsideSystemBars() throws Exception {
        Context context = test.getTargetContext();
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        assertNotNull(intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
        DesktopViewerActivity home = (DesktopViewerActivity) test.startActivitySync(intent);
        try {
            Intent old = new Intent().setClassName(context, context.getPackageName() + ".ShareActivity");
            assertEquals(DesktopViewerActivity.class.getName(), context.getPackageManager()
                    .getActivityInfo(old.getComponent(), 0).targetActivity);
            WebView web = findWebView(home.findViewById(android.R.id.content));
            assertNotNull(web);
            long deadline = SystemClock.elapsedRealtime() + 12000;
            AtomicReference<String> state = new AtomicReference<>();
            while (SystemClock.elapsedRealtime() < deadline && !"true".equals(state.get())) {
                CountDownLatch done = new CountDownLatch(1);
                test.runOnMainSync(() -> web.evaluateJavascript(
                    "document.body?.dataset.page === 'devices' && document.getElementById('self-name')?.textContent === PhoneDevices.name() && document.getElementById('connected-count')?.textContent === '0'",
                    result -> { state.set(result); done.countDown(); }));
                assertTrue(done.await(3, TimeUnit.SECONDS));
                SystemClock.sleep(100);
            }
            assertEquals("Launcher did not open the device directory", "true", state.get());
            if (Build.VERSION.SDK_INT >= 30) test.runOnMainSync(() -> {
                View decor = home.getWindow().getDecorView();
                WindowInsets insets = decor.getRootWindowInsets();
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                assertTrue("Expected a visible status bar", bars.top > 0);
                int[] pos = new int[2], origin = new int[2];
                web.getLocationInWindow(pos);
                decor.getLocationInWindow(origin);
                assertTrue(pos[1] >= origin[1] + bars.top);
                assertTrue(pos[1] + web.getHeight() <= origin[1] + decor.getHeight() - bars.bottom);
                assertTrue(pos[0] >= origin[0] + bars.left);
                assertTrue(pos[0] + web.getWidth() <= origin[0] + decor.getWidth() - bars.right);
            });
        } finally {
            test.runOnMainSync(home::finish);
        }
    }
}
