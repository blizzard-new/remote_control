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

public final class ShareHostActivity extends Activity {
    private static final int SHARE = 1;
    private static final int NOTIFICATIONS = 2;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView details;
    private Button start, stop;
    private CheckBox highQuality;
    private android.widget.Switch internetMode;
    private android.widget.EditText relay;
    private LinearLayout pending;
    private Button copyInvite;
    private java.util.Map<String,String> rendered = new java.util.LinkedHashMap<>();
    private boolean prompting, renderedControl;
    private boolean renderedSharing, transferring, visitingSettings;
    private PhoneShare preview;
    private String previewError;
    private int previousViewers = -1;
    private boolean leaveCodePage;
    private Button enable;
    private AppUpdates updates;

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
        viewer.setOnClickListener(v -> startActivity(new Intent(this, LanViewerActivity.class)));

        Button onlineViewer=new Button(this);
        onlineViewer.setText("返回裝置列表");
        onlineViewer.setOnClickListener(v -> startActivity(new Intent(this, DesktopViewerActivity.class)));
        page.addView(onlineViewer);

        TextView shareHeading = new TextView(this);
        shareHeading.setText("讓電腦連到這支手機");
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

        internetMode=new android.widget.Switch(this);
        internetMode.setText("跨網路分享（行動網路或 Wi-Fi）");
        internetMode.setChecked(savedState == null || savedState.getBoolean("internet", true));

        enable=new Button(this);
        enable.setText("啟用手機觸控操作（第一次設定）");
        enable.setOnClickListener(v -> new android.app.AlertDialog.Builder(this).setTitle("允許電腦操作手機")
            .setMessage("在無障礙設定開啟「遠端桌面觸控操作」。回來分享整個螢幕，再對連線按「允許操作」。")
            .setPositiveButton("前往設定",(dialog,which)->{
                visitingSettings = true;
                startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
            })
            .setNegativeButton("取消",null).show());
        page.addView(enable);
        relay=new android.widget.EditText(this);
        relay.setSingleLine(); relay.setHint("配對服務 HTTPS 網址");
        relay.setText(getSharedPreferences("ShareActivity", MODE_PRIVATE).getString("relay", InternetHost.DEFAULT));

        pending=new LinearLayout(this);pending.setOrientation(LinearLayout.VERTICAL);
        copyInvite=new Button(this);copyInvite.setText("複製四位數配對碼");
        copyInvite.setOnClickListener(v -> {
            PhoneShare host=currentHost();
            if(host!=null && !host.invitation().isEmpty()) getSystemService(android.content.ClipboardManager.class)
                .setPrimaryClip(android.content.ClipData.newPlainText("四位數配對碼",host.invitation()));
        });
        page.addView(copyInvite);page.addView(pending);
        start = new Button(this);
        start.setText(internetMode.isChecked() ? "開放整個螢幕連線" : "選擇分享畫面");
        internetMode.setOnCheckedChangeListener((button, checked) -> {
            start.setText(checked ? "開放整個螢幕連線" : "選擇分享畫面");
            if (checked) prepareCode();
            else { PhoneShare.releasePreview(preview); preview = null; previewError = null; }
        });
        start.setOnClickListener(v -> {
            if(internetMode.isChecked()) {
                try { DesktopOrigin.viewerUrl(relay.getText().toString().trim()); }
                catch(IllegalArgumentException e) { relay.setError("請輸入有效的 HTTPS 服務網址"); return; }
                getSharedPreferences("ShareActivity", MODE_PRIVATE).edit().putString("relay",relay.getText().toString().trim()).apply();
                if (!prepareCode()) return;
            }
            prompting = true;
            start.setEnabled(false);
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED
                    && !getSharedPreferences("ShareActivity", MODE_PRIVATE).getBoolean("askedNotifications", false)) {
                getSharedPreferences("ShareActivity", MODE_PRIVATE).edit().putBoolean("askedNotifications", true).apply();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
            } else askProjection();
        });
        page.addView(start);
        stop = new Button(this);
        stop.setText("停止分享並中斷所有觀看者");
        stop.setOnClickListener(v -> stopService(new Intent(this, CaptureService.class)));
        page.addView(stop);
        Button more=new Button(this);more.setText("進階連線設定");page.addView(more);
        LinearLayout options=new LinearLayout(this);options.setOrientation(LinearLayout.VERTICAL);
        options.addView(internetMode);options.addView(relay);options.addView(highQuality);options.addView(viewer);
        options.setVisibility(View.GONE);page.addView(options);
        more.setOnClickListener(v->options.setVisibility(options.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE));
        updates = new AppUpdates(this, page);
        scroll.addView(page);
        new ScreenInsets(this, scroll);
    }

    private PhoneShare currentHost() {
        return CaptureService.status.running ? CaptureService.online : preview;
    }

    private boolean prepareCode() {
        try {
            preview = PhoneShare.prepare(this, relay.getText().toString().trim());
            previewError = null;
            return true;
        } catch (Exception e) {
            PhoneShare.releasePreview(preview);
            preview = null;
            previewError = "無法取得手機連線碼。請檢查進階連線設定中的 HTTPS 服務網址。";
            return false;
        }
    }

    private void askProjection() {
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        Intent request=Build.VERSION.SDK_INT>=34 && internetMode.isChecked()
            ?manager.createScreenCaptureIntent(android.media.projection.MediaProjectionConfig.createConfigForDefaultDisplay())
            :manager.createScreenCaptureIntent();
        startActivityForResult(request, SHARE);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATIONS && prompting) askProjection();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("internet",internetMode.isChecked());
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
            if(internetMode.isChecked()) service.putExtra("internet",relay.getText().toString().trim());
            transferring = true;
            startForegroundService(service);
        }
    }

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            CaptureService.Status status = CaptureService.status;
            if (status.running) { preview = null; transferring = false; }
            PhoneShare host=currentHost();
            String message = status.running ? status.text : host != null ? host.status() :
                previewError == null ? status.text : previewError;
            if (!details.getText().toString().equals(message)) details.setText(message);
            enable.setVisibility(PhoneControl.enabled()?View.GONE:View.VISIBLE);
            start.setEnabled(!prompting && !status.running);
            internetMode.setEnabled(!prompting && !status.running);
            relay.setVisibility(internetMode.isChecked() && !status.running ? View.VISIBLE : View.GONE);
            highQuality.setEnabled(!internetMode.isChecked() && !prompting && !status.running);
            int count = host == null ? 0 : host.viewers();
            if (count == 0) leaveCodePage = false;
            else if (previousViewers == 0) leaveCodePage = true;
            if (leaveCodePage && status.running && hasWindowFocus() && moveTaskToBack(true))
                leaveCodePage = false;
            previousViewers = count;
            copyInvite.setVisibility(host!=null && !host.invitation().isEmpty() ? View.VISIBLE : View.GONE);
            java.util.Map<String,String> requests=host==null ? java.util.Collections.emptyMap() : host.pending();
            boolean canControl=PhoneControl.available();
            boolean sharing=host!=null && host.sharing();
            if(!requests.equals(rendered) || canControl!=renderedControl || sharing!=renderedSharing) {
                renderedControl=canControl;
                renderedSharing=sharing;
                rendered=requests; pending.removeAllViews();
                for(java.util.Map.Entry<String,String> entry:requests.entrySet()) {
                    String id=entry.getKey();
                    TextView name=new TextView(ShareHostActivity.this);name.setText(entry.getValue()+" 請求連線。首次允許後，此裝置可依相同權限直接重連。");pending.addView(name);
                    if (!sharing) continue;
                    if (host.requestedControl(id) && !canControl) {
                        TextView help = new TextView(ShareHostActivity.this);
                        help.setText(PhoneControl.busy() ? "目前有其他裝置正在操作。" :
                            "要操作手機，請先開啟「遠端桌面觸控操作」，並選擇分享整個螢幕。");
                        pending.addView(help);
                    }
                    if(canControl && host.requestedControl(id)) {
                        Button control=new Button(ShareHostActivity.this);control.setText("允許操作");
                        control.setOnClickListener(v -> { host.decide(id,true,true); moveTaskToBack(true); });pending.addView(control);
                    }
                    for(boolean allow:new boolean[]{true,false}) {
                        Button decision=new Button(ShareHostActivity.this);decision.setText(allow?"允許觀看":"拒絕");
                        decision.setOnClickListener(v -> host.decide(id,allow,false));pending.addView(decision);
                    }
                }
            }
            stop.setVisibility(status.running ? View.VISIBLE : View.GONE);
            main.postDelayed(this, 500);
        }
    };

    @Override protected void onResume() {
        super.onResume();
        visitingSettings = false;
        if (!CaptureService.status.running && internetMode.isChecked()) prepareCode();
        refresh.run();
        updates.resumed();
    }

    @Override protected void onDestroy() {
        if (!isChangingConfigurations()) PhoneShare.releasePreview(preview);
        updates.close();
        super.onDestroy();
    }

    @Override protected void onStop() {
        if (!prompting && !visitingSettings && !transferring && !isChangingConfigurations()) {
            PhoneShare.releasePreview(preview);
            preview = null;
        }
        super.onStop();
    }

    @Override protected void onPause() {
        previousViewers = -1;
        main.removeCallbacks(refresh);
        super.onPause();
    }
}
