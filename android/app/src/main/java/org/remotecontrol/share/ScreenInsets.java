package org.remotecontrol.share;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;

/** Keep the dashboard inside visible system bars, including on edge-to-edge Android 15. */
final class ScreenInsets {
    static final int LIGHT_BARS = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    private final FrameLayout root;
    private boolean immersive;

    ScreenInsets(Activity activity, View content) {
        Window window = activity.getWindow();
        int background = Color.rgb(240, 246, 252);
        root = new FrameLayout(activity);
        root.setBackgroundColor(background);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                int types = WindowInsets.Type.ime();
                if (!immersive) types |= WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
                Insets area = insets.getInsets(types);
                v.setPadding(area.left, area.top, area.right, area.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            window.setStatusBarColor(background);
            window.setNavigationBarColor(background);
            window.getDecorView().setSystemUiVisibility(LIGHT_BARS);
        }
        root.addView(content);
        activity.setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            window.setNavigationBarContrastEnforced(false);
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            window.getInsetsController().setSystemBarsAppearance(light, light);
        }
    }

    void setImmersive(boolean value) {
        immersive = value;
        root.requestApplyInsets();
    }
}
