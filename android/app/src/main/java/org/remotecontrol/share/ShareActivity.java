package org.remotecontrol.share;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class ShareActivity extends Activity {
    private static final int SHARE = 1;
    private static final int NOTIFICATIONS = 2;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView details;
    private Button start, stop;
    private CheckBox highQuality;
    private boolean prompting;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        // The credentials on this screen must never appear in a projection.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        prompting = savedState != null && savedState.getBoolean("prompting");
        ScrollView scroll = new ScrollView(this);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        page.setPadding(padding, padding * 2, padding, padding);
        TextView title = new TextView(this);
        title.setText("遠端螢幕");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        page.addView(title);
        Button viewer = new Button(this);
        viewer.setText("連接電腦（鍵盤觸控板模式）");
        viewer.setOnClickListener(v -> startActivity(new Intent(this, DesktopViewerActivity.class)));
        page.addView(viewer);
        TextView shareHeading = new TextView(this);
        shareHeading.setText("分享 Android 螢幕");
        shareHeading.setTextSize(20);
        shareHeading.setPadding(0, padding, 0, 0);
        page.addView(shareHeading);
        details = new TextView(this);
        details.setTextSize(17);
        details.setTextIsSelectable(true);
        details.setPadding(0, padding, 0, padding);
        page.addView(details);
        highQuality = new CheckBox(this);
        highQuality.setText("高畫質 H.264（目標 30 fps，需支援 WebCodecs 的瀏覽器）");
        highQuality.setChecked(savedState == null || savedState.getBoolean("highQuality", true));
        page.addView(highQuality);
        start = new Button(this);
        start.setText("選擇分享畫面");
        start.setOnClickListener(v -> {
            prompting = true;
            start.setEnabled(false);
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED
                    && !getPreferences(MODE_PRIVATE).getBoolean("askedNotifications", false)) {
                getPreferences(MODE_PRIVATE).edit().putBoolean("askedNotifications", true).apply();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
            } else askProjection();
        });
        page.addView(start);
        stop = new Button(this);
        stop.setText("停止分享並中斷所有觀看者");
        stop.setOnClickListener(v -> stopService(new Intent(this, CaptureService.class)));
        page.addView(stop);
        scroll.addView(page);
        setContentView(scroll);
    }

    private void askProjection() {
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        startActivityForResult(manager.createScreenCaptureIntent(), SHARE);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATIONS && prompting) askProjection();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("highQuality", highQuality.isChecked());
        state.putBoolean("prompting", prompting);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SHARE) return;
        prompting = false;
        if (result == RESULT_OK && data != null) {
            Intent service = new Intent(this, CaptureService.class)
                    .putExtra("result", result).putExtra("consent", data)
                    .putExtra("highQuality", highQuality.isChecked());
            startForegroundService(service);
        }
    }

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            CaptureService.Status status = CaptureService.status;
            if (!details.getText().toString().equals(status.text)) details.setText(status.text);
            start.setEnabled(!prompting && !status.running);
            highQuality.setEnabled(!prompting && !status.running);
            stop.setVisibility(status.running ? View.VISIBLE : View.GONE);
            main.postDelayed(this, 500);
        }
    };

    @Override protected void onResume() {
        super.onResume();
        refresh.run();
    }

    @Override protected void onPause() {
        main.removeCallbacks(refresh);
        super.onPause();
    }
}
