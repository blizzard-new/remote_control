package org.remotecontrol.share;

import android.content.Context;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.webkit.WebView;
import org.json.JSONObject;

/** Routes Android scroll axes to the same input channel as browser wheel events. */
final class TrackpadWebView extends WebView {
    private final String origin;
    private final ViewConfiguration config;
    private int documentVersion;
    private boolean committed;

    TrackpadWebView(Context context, String origin) {
        super(context);
        this.origin = origin;
        config = ViewConfiguration.get(context);
    }

    void navigationStarted() {
        documentVersion++;
        committed = false;
    }

    void navigationCommitted(String address) {
        committed = DesktopOrigin.matches(origin, address);
    }

    @Override public boolean onGenericMotionEvent(MotionEvent event) {
        if (!committed || event.getActionMasked() != MotionEvent.ACTION_SCROLL ||
                !(event.isFromSource(InputDevice.SOURCE_CLASS_POINTER) || event.isFromSource(InputDevice.SOURCE_TOUCHPAD)) ||
                !DesktopOrigin.matches(origin, getUrl())) return super.onGenericMotionEvent(event);
        String arguments = wheelArguments(event.getX(), event.getY(), event.getAxisValue(MotionEvent.AXIS_HSCROLL),
                event.getAxisValue(MotionEvent.AXIS_VSCROLL), config.getScaledHorizontalScrollFactor(),
                config.getScaledVerticalScrollFactor(), getWidth(), getHeight());
        if (arguments == null) return super.onGenericMotionEvent(event);
        MotionEvent original = MotionEvent.obtain(event);
        int version = documentVersion;
        // This is one-way page evaluation. The page has no native interface.
        String route = "location.origin===" + JSONObject.quote(origin)
                + " && typeof window.remoteControlAndroidWheel==='function' && window.remoteControlAndroidWheel("
                + arguments + ")===true";
        evaluateJavascript(route, handled -> {
            try {
                if (version == documentVersion && committed && !"true".equals(handled)
                        && DesktopOrigin.matches(origin, getUrl()) && isAttachedToWindow()) {
                    // Restore the original browser event over controls, letterboxing, and normal webpages.
                    super.onGenericMotionEvent(original);
                }
            } finally { original.recycle(); }
        });
        return true;
    }

    static String wheelArguments(float x, float y, float horizontal, float vertical, float factorX, float factorY,
                                int width, int height) {
        if (width <= 0 || height <= 0 || (horizontal == 0 && vertical == 0)) return null;
        double dx = (double) horizontal * factorX / width;
        double dy = -(double) vertical * factorY / height;
        if (!Float.isFinite(x) || !Float.isFinite(y) || !Double.isFinite(dx) || !Double.isFinite(dy)) return null;
        return (double) x / width + "," + (double) y / height + "," + dx + "," + dy;
    }

    @Override public void destroy() {
        navigationStarted();
        super.destroy();
    }
}
