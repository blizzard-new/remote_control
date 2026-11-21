package org.remotecontrol.share;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.*;
import android.widget.*;
import java.io.ByteArrayInputStream;

public final class DesktopViewerActivity extends Activity {
    private LinearLayout page;
    private TrackpadWebView viewer;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        setContentView(page);
        addressForm("", null);
    }

    private void addressForm(String address, String error) {
        closeViewer();
        page.removeAllViews();
        int space = (int) (20 * getResources().getDisplayMetrics().density);
        page.setPadding(space, space * 2, space, space);
        TextView title = new TextView(this);
        title.setText("連接電腦");
        title.setTextSize(24);
        page.addView(title);
        TextView help = new TextView(this);
        help.setText(error != null ? error : "輸入電腦顯示的 HTTPS 觀看網址。連線後再輸入連線碼。");
        page.addView(help);
        EditText input = new EditText(this);
        input.setSingleLine();
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://192.168.1.20:8443/");
        input.setText(address);
        page.addView(input);
        Button connect = new Button(this);
        connect.setText("開啟觀看頁");
        connect.setOnClickListener(v -> {
            try { showViewer(DesktopOrigin.viewerUrl(input.getText().toString().trim())); }
            catch (IllegalArgumentException invalid) { input.setError("請輸入 HTTPS 觀看網址。主機專用的 #host= 連結只供電腦使用。"); }
        });
        page.addView(connect);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showViewer(String address) {
        String origin = DesktopOrigin.of(address);
        page.removeAllViews();
        page.setPadding(0, 0, 0, 0);
        TrackpadWebView view = new TrackpadWebView(this, origin);
        viewer = view;
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setSupportMultipleWindows(false);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                return !DesktopOrigin.matches(origin, request.getUrl().toString());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                if (DesktopOrigin.matches(origin, request.getUrl().toString())) return null;
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                        java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageStarted(WebView web, String url, Bitmap favicon) {
                view.navigationStarted();
                if (!DesktopOrigin.matches(origin, url)) fail("請直接輸入目標電腦的 HTTPS 觀看網址。");
            }
            @Override public void onPageCommitVisible(WebView web, String url) { view.navigationCommitted(url); }
            @Override public void onReceivedSslError(WebView web, SslErrorHandler handler, SslError problem) {
                handler.cancel();
                fail("無法驗證主機憑證。請核對主機上的根憑證指紋，在 Android 安裝相符的 CA 憑證後重試。");
            }
            @Override public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) fail("無法開啟觀看頁，請確認電腦已啟動分享、網址正確且網路互通。");
            }
            private void fail(String message) {
                view.post(() -> { if (viewer == view) addressForm(address, message); });
            }
        });
        page.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        view.loadUrl(address);
    }

    private void closeViewer() {
        if (viewer == null) return;
        TrackpadWebView closing = viewer;
        viewer = null;
        closing.navigationStarted();
        page.removeView(closing);
        closing.stopLoading();
        closing.setWebViewClient(new WebViewClient());
        closing.destroy();
    }

    @Override public void onPause() {
        if (viewer != null) viewer.onPause();
        super.onPause();
    }

    @Override public void onResume() {
        super.onResume();
        if (viewer != null) viewer.onResume();
    }

    @Override public void onDestroy() {
        closeViewer();
        super.onDestroy();
    }
}
