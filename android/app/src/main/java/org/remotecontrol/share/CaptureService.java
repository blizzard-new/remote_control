package org.remotecontrol.share;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;
import java.io.InputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.nio.ByteBuffer;

public final class CaptureService extends Service {
    static final class Status {
        final boolean running;
        final String text;
        final int lanViewers;
        Status(boolean running, String text) { this(running, text, -1); }
        Status(boolean running, String text, int lanViewers) {
            this.running = running;
            this.text = text;
            this.lanViewers = lanViewers;
        }
    }
    static volatile Status status = new Status(false, "讓電腦連到這台手機，或用手機操作另一台電腦。");
    private static final String CHANNEL = "screen-share";
    private static final String STOP = "stop-share";
    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread thread;
    private Handler worker;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private boolean highQuality;
    private AvcEncoder encoder;
    private int encodedSourceWidth, encodedSourceHeight;
    private ScreenServer server;
    static volatile PhoneShare online;
    private PhoneShare internet;
    private String internetAddress;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Bitmap bitmap;
    private ByteBuffer packed;
    private final ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
    private boolean scheduled;
    private long lastFrame;
    private boolean captured;
    private int rawWidth, rawHeight, codecProfile, failedProfile;
    private volatile boolean destroyed;
    private String endReason = "分享已停止，所有連線已關閉。";

    @Override public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("share-capture");
        thread.start();
        worker = new Handler(thread.getLooper());
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "螢幕分享", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (status.running) return START_NOT_STICKY;
        Intent consent = intent.getParcelableExtra("consent");
        if (intent.getIntExtra("result", 0) != Activity.RESULT_OK || consent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, CaptureService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 2,
                new Intent(this, ShareHostActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_view).setContentTitle("正在分享 Android 螢幕")
                .setContentText("按此查看配對資訊或結束分享。").setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "停止分享", stop).build()).build();
        try {
            startForeground(1, notification);
        } catch (SecurityException error) {
            endReason = "系統未授權螢幕分享。請回到主畫面重新選擇。";
            stopSelf();
            return START_NOT_STICKY;
        }
        internetAddress = intent.getStringExtra("internet");
        highQuality = internetAddress == null && intent.getBooleanExtra("highQuality", false);
        status = new Status(true, "正在建立加密連線…");
        if (internetAddress != null) {
            try {
                internet = PhoneShare.takeForCapture(this, internetAddress);
                online = internet;
            } catch (Exception e) { stopWith("無法開放手機連線：" + reason(e)); return START_NOT_STICKY; }
        }
        worker.post(() -> {
            try { begin(consent); }
            catch (Exception error) { stopWith("無法開始分享：" + reason(error)); }
        });
        return START_NOT_STICKY;
    }

    private static String reason(Exception error) {
        String message = error.getLocalizedMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private void begin(Intent consent) throws Exception {
        if (destroyed) return;
        if (internetAddress != null) {
            beginProjection(consent);
            internet.startSharing();
            worker.postDelayed(new Runnable() {
                @Override public void run() {
                    if (destroyed) return;
                    if (rawWidth > 0) changeSize(rawWidth, rawHeight);
                    if (encoder == null && captured && internet.viewers() > 0 && SystemClock.uptimeMillis() - lastFrame >= 500)
                        internet.publish(bitmap, jpeg, worker);
                    worker.postDelayed(this, 500);
                }
            },500);
            main.post(new Runnable() {
                @Override public void run() {
                    if (destroyed) return;
                    status = new Status(true, internet.status());
                    main.postDelayed(this, 500);
                }
            });
            return;
        }
        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        Network network = connectivity.getActiveNetwork();
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        LinkProperties links = connectivity.getLinkProperties(network);
        boolean vpn = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        if (links == null || caps == null || (!vpn && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))) {
            throw new IllegalStateException("請使用與電腦互通的 Wi-Fi 或私人 VPN。");
        }
        String transport = vpn ? "VPN" : "Wi-Fi";
        InetAddress address = links.getLinkAddresses().stream().map(LinkAddress::getAddress)
                .filter(ShareNetwork::privateAddress).findFirst()
                .orElseThrow(() -> new IllegalStateException(transport + " 沒有可用的私人 IPv4 位址。"));
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onLost(Network old) {
                if (network.equals(old)) stopWith(transport + " 已中斷，請重新開始分享。");
            }
            @Override public void onAvailable(Network current) {
                if (!network.equals(current)) stopWith("使用中的網路已變更，請重新開始分享。");
            }
            @Override public void onLinkPropertiesChanged(Network current, LinkProperties properties) {
                if (network.equals(current) && properties.getLinkAddresses().stream()
                        .noneMatch(link -> address.equals(link.getAddress()))) {
                    stopWith(transport + " 位址已變更，請重新開始分享。");
                }
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback, worker);
        LocalIdentity identity = new LocalIdentity();
        server = new ScreenServer(address, identity.context(), highQuality ? readPlayer() : null);
        String invitation = "請從同一個 " + transport + " 的電腦開啟\n" + server.url() + "\n\n在瀏覽器的憑證資訊中核對 SHA-256 指紋，再繼續：\n"
                + identity.fingerprint() + "\n\n配對碼\n" + server.code()
                + "\n\n配對後請切換到要展示的畫面。此頁面受到保護，觀看者會看到黑畫面。";
        beginProjection(consent);
        invitation += highQuality ? "\n\nH.264 模式 · 目標 30 fps" : "\n\n相容模式 · MJPEG";
        String sessionInfo = invitation;
        server.start(() -> stopWith("無法接受新的觀看者，分享已停止。"));
        ScreenServer active = server;
        main.post(new Runnable() {
            @Override public void run() {
                if (destroyed) return;
                int count = active.viewers();
                status = new Status(true, sessionInfo + "\n\n目前觀看裝置：" + count, count);
                main.postDelayed(this, 1_000);
            }
        });
    }

    private void beginProjection(Intent consent) {
        projection = getSystemService(MediaProjectionManager.class).getMediaProjection(Activity.RESULT_OK, consent);
        if (projection == null) throw new IllegalStateException("系統拒絕擷取螢幕。");
        projection.registerCallback(projectionCallback, worker);
        DisplayMetrics metrics = screenMetrics(this);
        resize(metrics.widthPixels, metrics.heightPixels);
    }

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() { stopWith("系統已停止螢幕分享。"); }
        @Override public void onCapturedContentResize(int width, int height) { changeSize(width, height); }
    };

    private void changeSize(int width, int height) {
        if (destroyed || projection == null) return;
        try { resize(width, height); }
        catch (RuntimeException error) { stopWith("無法調整擷取範圍：" + reason(error)); }
    }

    static DisplayMetrics screenMetrics(android.content.Context context) {
        Display screen = context.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        DisplayMetrics metrics = new DisplayMetrics();
        screen.getRealMetrics(metrics);
        return metrics;
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        if (Build.VERSION.SDK_INT < 34) worker.post(() -> {
            DisplayMetrics metrics = screenMetrics(this);
            changeSize(metrics.widthPixels, metrics.heightPixels);
        });
    }

    private String readPlayer() throws IOException {
        try (InputStream input = getAssets().open("avc-player.mjs");
             ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) buffer.write(chunk, 0, count);
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void attachSurface(int width, int height, int dpi, Surface surface) {
        if (display == null) {
            display = projection.createVirtualDisplay("Remote Screen", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, worker);
            if (display == null) throw new IllegalStateException("系統無法建立擷取畫面。");
        } else {
            display.resize(width, height, dpi);
            display.setSurface(surface);
        }
    }

    private void resize(int sourceWidth, int sourceHeight) {
        if (sourceWidth <= 0 || sourceHeight <= 0) return;
        rawWidth = sourceWidth; rawHeight = sourceHeight;
        if (internet != null) {
            PhoneControl.captureSize(sourceWidth,sourceHeight);
            int wanted=internet.codecProfile();
            if (wanted==failedProfile) wanted=0;
            if (encoder!=null && wanted==codecProfile && encodedSourceWidth==sourceWidth && encodedSourceHeight==sourceHeight) return;
            if (encoder!=null) { display.setSurface(null); encoder.close(); encoder=null; }
            codecProfile=0;
            if (wanted>0) {
                final int selected=wanted;
                try {
                    encoder=AvcEncoder.open(sourceWidth,sourceHeight,worker,internet::video,
                        error -> worker.post(() -> { if (codecProfile==selected && !destroyed) {failedProfile=selected; changeSize(rawWidth,rawHeight);} }),
                        (wanted & ~VideoQuality.SHARP_BIT) / 100, (wanted & ~VideoQuality.SHARP_BIT) % 100,
                        (wanted & VideoQuality.SHARP_BIT) != 0);
                    int dpi=Math.max(1,Math.round(getResources().getDisplayMetrics().densityDpi * encoder.width/(float)sourceWidth));
                    attachSurface(encoder.width,encoder.height,dpi,encoder.surface);
                    if (reader!=null) {reader.close();reader=null;}
                    if (bitmap!=null) {bitmap.recycle();bitmap=null;packed=null;}
                    captured=false; codecProfile=wanted; encodedSourceWidth=sourceWidth; encodedSourceHeight=sourceHeight;
                    return;
                } catch (RuntimeException unavailable) {
                    if (encoder!=null) {encoder.close();encoder=null;}
                    failedProfile=wanted;
                }
            }
        }
        if (highQuality) {
            if (encoder != null && sourceWidth == encodedSourceWidth && sourceHeight == encodedSourceHeight) return;
            if (encoder != null) {
                display.setSurface(null);
                encoder.close();
                encoder = null;
            }
            server.avcFrames.reset();
            encoder = AvcEncoder.open(sourceWidth, sourceHeight, worker, server.avcFrames, this::stopWith);
            int dpi = Math.max(1, Math.round(getResources().getDisplayMetrics().densityDpi *
                    (encoder.width / (float) sourceWidth)));
            attachSurface(encoder.width, encoder.height, dpi, encoder.surface);
            encodedSourceWidth = sourceWidth;
            encodedSourceHeight = sourceHeight;
            return;
        }
        int edge = internet == null ? 1280 : Math.max(960, internet.edge());
        double scale = Math.min(1, edge / (double)Math.max(sourceWidth, sourceHeight));
        int w = Math.max(1, (int) Math.round(sourceWidth * scale));
        int h = Math.max(1, (int) Math.round(sourceHeight * scale));
        if (reader != null && reader.getWidth() == w && reader.getHeight() == h) return;
        int dpi = Math.max(1, (int) Math.round(getResources().getDisplayMetrics().densityDpi * scale));
        ImageReader previous = reader;
        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(current -> {
            if (current == reader && !scheduled && !destroyed) {
                scheduled = true;
                // Acquire the newest frame at the deadline, keeping memory and slow clients bounded.
                long period = internet == null ? (server.viewers() > 0 ? 84 : 500) : (internet.fps() == 60 ? 16 : internet.fps() == 30 ? 33 : 500);
                worker.postAtTime(this::encodeFrame, Math.max(SystemClock.uptimeMillis(), lastFrame + period));
            }
        }, worker);
        try {
            attachSurface(w, h, dpi, reader.getSurface());
        } finally {
            if (previous != null) previous.close();
        }
        if (bitmap != null) bitmap.recycle();
        captured = false;
        bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        packed = ByteBuffer.allocateDirect(w * h * 4);
    }

    private void encodeFrame() {
        scheduled = false;
        if (destroyed || reader == null) return;
        try (Image image = reader.acquireLatestImage()) {
            if (image == null) return;
            lastFrame = SystemClock.uptimeMillis();
            Image.Plane plane = image.getPlanes()[0];
            if (plane.getPixelStride() != 4) throw new IllegalStateException("無法讀取 RGBA 畫素。");
            ByteBuffer source = plane.getBuffer();
            int length = bitmap.getWidth() * 4;
            int base = source.position();
            packed.clear();
            for (int y = 0; y < bitmap.getHeight(); y++) {
                int offset = base + y * plane.getRowStride();
                source.limit(offset + length);
                source.position(offset);
                packed.put(source);
            }
            packed.flip();
            bitmap.copyPixelsFromBuffer(packed);
            captured = true;
            if (internet != null) { internet.publish(bitmap, jpeg, worker); return; }
            jpeg.reset();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 76, jpeg)) throw new IllegalStateException("JPEG 編碼失敗。");
            server.publish(jpeg.toByteArray());
        } catch (RuntimeException error) {
            stopWith("畫面擷取中斷：" + reason(error));
        }
    }

    private void stopWith(String message) {
        PhoneControl.releaseAll();PhoneControl.captureSize(0,0);
        main.post(() -> {
            if (destroyed) return;
            endReason = message;
            stopSelf();
        });
    }

    @Override public void onDestroy() {
        destroyed = true;
        PhoneControl.releaseAll(); PhoneControl.captureSize(0,0);
        status = new Status(false, endReason);
        if (online == internet) online = null;
        main.removeCallbacksAndMessages(null);
        worker.postAtFrontOfQueue(() -> {
            if (internet != null) internet.close();
            if (server != null) server.close();
            if (display != null) display.release();
            if (encoder != null) encoder.close();
            if (reader != null) reader.close();
            if (bitmap != null) bitmap.recycle();
            if (projection != null) {
                projection.unregisterCallback(projectionCallback);
                projection.stop();
            }
            if (networkCallback != null) {
                try { getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback); }
                catch (IllegalArgumentException ignored) {}
            }
            thread.quit();
        });
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
