package org.remotecontrol.share;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

final class AppUpdates {
    private static final String REPO = "blizzard-new/remote_control";
    private static final String APK = "RemoteControl-Android.apk";
    private static final String API = "https://api.github.com/repos/" + REPO + "/releases/latest";
    private static final long LIMIT = 160L * 1024 * 1024;
    private final Activity activity;
    private final TextView status;
    private final Button check, install;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().followSslRedirects(false)
        .callTimeout(3, TimeUnit.MINUTES).addNetworkInterceptor(chain -> {
            String host = chain.request().url().host();
            if (!chain.request().url().isHttps() || !(host.equals("github.com") || host.equals("api.github.com")
                || host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com")))
                throw new IOException("更新下載位置無效。");
            return chain.proceed(chain.request());
        }).build();
    private Offer offer;
    private boolean waitingForPermission;

    private static final class Offer {
        final String version, url, hash;
        final long size;
        Offer(String version, String url, String hash, long size) {
            this.version = version; this.url = url; this.hash = hash; this.size = size;
        }
    }

    private Runnable observer;
    AppUpdates(Activity activity, LinearLayout page) { this(activity,page,null); }
    AppUpdates(Activity activity, LinearLayout page, Runnable observer) {
        this.observer=observer;
        this.activity = activity;
        status = new TextView(activity);
        check = new Button(activity); check.setText("檢查更新");
        install = new Button(activity); install.setText("立即更新");
        install.setVisibility(View.GONE);
        page.addView(status); page.addView(check); page.addView(install);
        check.setOnClickListener(v -> check());
        install.setOnClickListener(v -> install());
        check();
    }

    static int compare(String a, String b) {
        String[] x = a.split("\\.", -1), y = b.split("\\.", -1);
        if (x.length != 3 || y.length != 3) throw new IllegalArgumentException("無效版本。");
        for (int i = 0; i < 3; i++) {
            int difference = Integer.compare(Integer.parseInt(x[i]), Integer.parseInt(y[i]));
            if (difference != 0) return difference;
        }
        return 0;
    }

    private Response get(String url) throws IOException {
        Response response = http.newCall(new Request.Builder().url(url)
            .header("User-Agent","Uniway-RemoteControl-Android").build()).execute();
        if (!response.isSuccessful() || response.body() == null) {
            int code = response.code(); response.close(); throw new IOException("GitHub HTTP " + code);
        }
        return response;
    }

    private Offer latest(String current) throws Exception {
        JSONObject release;
        try (Response response = get(API)) { release = new JSONObject(response.body().string()); }
        String tag = release.getString("tag_name");
        if (release.getBoolean("draft") || release.getBoolean("prerelease") || !tag.matches("v[0-9]+\\.[0-9]+\\.[0-9]+"))
            throw new IOException("無法辨識正式版版本。");
        String version = tag.substring(1);
        if (compare(version, current) <= 0) return null;
        String url = "https://github.com/" + REPO + "/releases/download/" + tag + "/" + APK;
        JSONArray assets = release.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            String digest = asset.optString("digest");
            long size = asset.optLong("size");
            if (APK.equals(asset.optString("name")) && url.equals(asset.optString("browser_download_url"))
                && "uploaded".equals(asset.optString("state")) && digest.matches("sha256:[0-9a-f]{64}")
                && size > 0 && size <= LIMIT) return new Offer(version, url, digest.substring(7), size);
        }
        throw new IOException("Android 新版安裝檔尚未就緒。");
    }

    String message() { return status.getText().toString(); }
    boolean available() { return offer != null; }
    boolean busy() { return !check.isEnabled(); }
    void action(boolean installing) { if (!busy()) { if (installing) install(); else check(); } }

    private void pending(String text) {
        check.setEnabled(false); install.setEnabled(false); status.setText(text);
        if(observer!=null) observer.run();
    }

    private void show(String text) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        status.setText(text); check.setEnabled(true); install.setEnabled(true);
        install.setVisibility(offer == null ? View.GONE : View.VISIBLE);
        if(observer!=null) observer.run();
    }

    private void check() {
        offer = null;
        pending("正在檢查版本…");
        worker.execute(() -> {
            try {
                String current = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
                Offer found = latest(current);
                activity.runOnUiThread(() -> {
                    offer = found;
                    show("目前版本 " + current + (found == null ? " 已是最新。" : "，可更新至 " + found.version));
                });
            } catch (Exception e) { activity.runOnUiThread(() -> show("檢查更新失敗，可再試一次。" + e.getMessage())); }
        });
    }

    private void install() {
        if (offer == null) return;
        if (CaptureService.status.running) { show("請先停止螢幕連線，再安裝更新。"); return; }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = true;
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            } catch (android.content.ActivityNotFoundException e) {
                waitingForPermission = false; show("請在系統設定中允許此 App 安裝更新。");
            }
            return;
        }
        Offer chosen = offer;
        pending("正在下載並驗證安裝檔…");
        worker.execute(() -> {
            try {
                File file = download(chosen);
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing() || activity.isDestroyed()) return;
                    if (CaptureService.status.running) { show("請先停止連線，再按立即更新。"); return; }
                    Uri uri = UpdatePackage.uri(activity, file.getName());
                    Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { activity.startActivity(intent); show("請在 Android 安裝畫面確認更新。"); }
                    catch (android.content.ActivityNotFoundException e) { show("無法開啟系統安裝程式。"); }
                });
            } catch (Exception e) { activity.runOnUiThread(() -> show("下載更新失敗，可再試一次。" + e.getMessage())); }
        });
    }

    private File download(Offer chosen) throws Exception {
        File directory = new File(activity.getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) throw new IOException("無法儲存更新檔。");
        File part = File.createTempFile("download", ".apk", directory);
        File apk = new File(directory, chosen.hash + ".apk");
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (Response response = get(chosen.url); InputStream in = response.body().byteStream();
                    OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[65536];
                for (int n; (n = in.read(buffer)) != -1;) {
                    total += n;
                    if (total > chosen.size) throw new IOException("更新大小不符。");
                    sha.update(buffer, 0, n); out.write(buffer, 0, n);
                }
            }
            StringBuilder digest = new StringBuilder();
            for (byte b : sha.digest()) digest.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (total != chosen.size || !chosen.hash.contentEquals(digest)) throw new IOException("更新檔驗證失敗。");
            PackageManager pm = activity.getPackageManager();
            PackageInfo candidate = pm.getPackageArchiveInfo(part.toString(), PackageManager.GET_SIGNATURES);
            PackageInfo current = pm.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES);
            if (candidate == null || !current.packageName.equals(candidate.packageName)
                || !chosen.version.equals(candidate.versionName) || candidate.versionCode <= current.versionCode
                || current.signatures == null || current.signatures.length == 0 || !Arrays.equals(current.signatures, candidate.signatures))
                throw new IOException("更新的 App、版本或簽章與本機不符。");
            if (!part.renameTo(apk)) throw new IOException("無法儲存安裝檔。");
            return apk;
        } finally { if (part.exists()) part.delete(); }
    }

    void resumed() {
        if (!waitingForPermission) return;
        waitingForPermission = false;
        if (activity.getPackageManager().canRequestPackageInstalls()) install();
        else show("需在 Android 授權後才能安裝。");
    }

    void close() { http.dispatcher().cancelAll(); worker.shutdownNow(); }
}
