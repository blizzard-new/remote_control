package org.remotecontrol.share;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Level;
import java.util.logging.Logger;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

final class ScreenServer implements Closeable {
    private static final String LOGIN = """
            <!doctype html><html lang="zh-Hant"><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Android 螢幕分享</title>
            <style>body{max-width:32rem;margin:10vh auto;padding:1rem;font:1.1rem/1.6 system-ui}
            input,button{font:inherit;padding:.5rem}input{max-width:100%;box-sizing:border-box}</style>
            <h1>觀看 Android 螢幕</h1><form action="/pair" method="post" autocomplete="off">
            <label for="code">輸入分享裝置上的配對碼</label><br>
            <input id="code" name="code" maxlength="24" required spellcheck="false" autocapitalize="none">
            <button>開始觀看</button></form></html>
            """;
    private static final String VIEW = """
            <!doctype html><html lang="zh-Hant"><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>觀看 Android 螢幕</title><style>
            body{margin:0;background:#161819;color:#fff;font:1rem system-ui;text-align:center}
            img{display:block;width:100%;height:calc(100vh - 3rem);object-fit:contain}
            </style><img src="/screen.mjpeg" alt="等待分享畫面"><p>Android 螢幕分享 · 關閉此分頁即可離開</p></html>
            """;
    private static final String AVC_VIEW = """
            <!doctype html><html lang="zh-Hant"><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1"><title>觀看 Android 螢幕</title>
            <style>body{margin:0;background:#161819;color:#fff;text-align:center;font:1rem system-ui}
            canvas{width:100%;height:calc(100vh - 5rem);object-fit:contain}p{margin:.5rem}</style>
            <canvas></canvas><p>等待畫面…</p><button hidden>重新連線</button>
            <script type="module" src="/avc-player.mjs"></script></html>
            """;
    final AvcFrames avcFrames = new AvcFrames();
    private final String avcPlayer;
    private static final String COOKIE = "__Host-remote_view=";
    private final SSLServerSocket listener;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private final Semaphore slots = new Semaphore(10);
    private final Semaphore streams = new Semaphore(6);
    private final Set<Socket> connected = ConcurrentHashMap.newKeySet();
    private final AtomicInteger viewers = new AtomicInteger();
    private final AtomicLong nextHandshakeLog = new AtomicLong(Long.MIN_VALUE);
    private final String code = randomHex(12), cookieValue = randomHex(24);
    private volatile boolean closed;
    private byte[] latest;
    private long serial;

    ScreenServer(InetAddress address, SSLContext context) throws IOException {
        this(address, context, null);
    }

    ScreenServer(InetAddress address, SSLContext context, String avcPlayer) throws IOException {
        this.avcPlayer = avcPlayer;
        listener = (SSLServerSocket) context.getServerSocketFactory()
                .createServerSocket(0, 12, address);
        listener.setEnabledProtocols(Arrays.asList(listener.getSupportedProtocols()).contains("TLSv1.3")
                ? new String[]{"TLSv1.3", "TLSv1.2"} : new String[]{"TLSv1.2"});
    }

    String url() { return "https://" + listener.getInetAddress().getHostAddress() + ":" + listener.getLocalPort(); }
    String code() { return code; }
    int viewers() { return viewers.get(); }

    private static String randomHex(int bytes) {
        byte[] random = new byte[bytes];
        new SecureRandom().nextBytes(random);
        StringBuilder result = new StringBuilder(bytes * 2);
        for (byte b : random) result.append(String.format(Locale.ROOT, "%02x", b));
        return result.toString();
    }

    void start(Runnable failed) {
        Thread thread = new Thread(() -> {
            try {
                while (!closed) {
                    SSLSocket socket = (SSLSocket) listener.accept();
                    if (!slots.tryAcquire()) { socket.close(); continue; }
                    connected.add(socket);
                    if (closed) { socket.close(); break; }
                    clients.execute(() -> {
                        try (SSLSocket client = socket) {
                            client.setSoTimeout(7_000);
                            try {
                                client.startHandshake();
                            } catch (IOException | RuntimeException failure) {
                                logHandshakeFailure(failure);
                                return;
                            }
                            handle(client);
                        } catch (IOException ignored) {
                            // A closed browser or incomplete TLS handshake ends this client only.
                        } finally {
                            connected.remove(socket);
                            slots.release();
                        }
                    });
                }
            } catch (IOException | java.util.concurrent.RejectedExecutionException failure) {
                if (!closed) failed.run();
            }
        }, "share-listener");
        thread.start();
    }

    private void logHandshakeFailure(Exception failure) {
        // Report only the TLS phase. Pairing credentials, request headers and video never enter this log.
        long now = System.nanoTime();
        long next = nextHandshakeLog.get();
        if (!closed && now >= next && nextHandshakeLog.compareAndSet(next, now + 10_000_000_000L)) {
            Logger.getLogger("RemoteScreenTLS").log(Level.WARNING, "Screen sharing TLS handshake failed", failure);
        }
    }

    synchronized void publish(byte[] jpeg) {
        latest = jpeg;
        serial++;
        notifyAll();
    }

    private void handle(Socket socket) throws IOException {
        InputStream in = new BufferedInputStream(socket.getInputStream());
        OutputStream out = new BufferedOutputStream(socket.getOutputStream());
        String request = line(in);
        Map<String, String> headers = new HashMap<>();
        int total = request.length();
        for (String header = line(in); !header.isEmpty(); header = line(in)) {
            total += header.length() + 2;
            if (total > 12_288) return;
            int colon = header.indexOf(':');
            if (colon < 1) return;
            headers.put(header.substring(0, colon).toLowerCase(Locale.ROOT), header.substring(colon + 1).trim());
        }
        String[] route = request.split(" ", 3);
        if (route.length != 3) return;
        String path = route[0] + " " + route[1];
        boolean paired = Arrays.stream(headers.getOrDefault("cookie", "").split(";"))
                .anyMatch(value -> same(value.trim(), COOKIE + cookieValue));
        switch (path) {
            case "GET /" -> respond(out, "200 OK", "", LOGIN);
            case "POST /pair" -> {
                String size = headers.getOrDefault("content-length", "");
                if (!size.matches("[0-9]{1,3}") || !headers.getOrDefault("content-type", "")
                        .equals("application/x-www-form-urlencoded")) {
                    respond(out, "400 Bad Request", "", "配對要求格式錯誤。");
                    return;
                }
                int length = Integer.parseInt(size);
                if (length > 64) { respond(out, "400 Bad Request", "", "配對碼太長。"); return; }
                byte[] body = new byte[length];
                new java.io.DataInputStream(in).readFully(body);
                String submitted = new String(body, StandardCharsets.US_ASCII).toLowerCase(Locale.ROOT);
                if (same(submitted, "code=" + code)) {
                    respond(out, "303 See Other", "Location: /view\r\nSet-Cookie: " + COOKIE
                            + cookieValue + "; Secure; HttpOnly; SameSite=Strict; Path=/\r\n", "");
                } else respond(out, "403 Forbidden", "", "配對碼有誤，請返回上一頁重試。");
            }
            case "GET /view", "GET /screen.mjpeg", "GET /screen.avc", "GET /avc-player.mjs" -> {
                if (!paired) { respond(out, "303 See Other", "Location: /\r\n", ""); return; }
                if (path.equals("GET /view")) {
                    respond(out, "200 OK", "", avcPlayer == null ? VIEW : AVC_VIEW);
                    return;
                }
                if (path.equals("GET /avc-player.mjs") && avcPlayer != null) {
                    respond(out, "200 OK", "", avcPlayer, "text/javascript; charset=utf-8");
                    return;
                }
                String endpoint = avcPlayer == null ? "GET /screen.mjpeg" : "GET /screen.avc";
                if (!path.equals(endpoint)) { respond(out, "404 Not Found", "", ""); return; }
                if (!streams.tryAcquire()) { respond(out, "503 Service Unavailable", "", "觀看人數已滿。"); return; }
                viewers.incrementAndGet();
                try {
                    if (avcPlayer == null) stream(out);
                    else streamAvc(out);
                }
                finally { viewers.decrementAndGet(); streams.release(); }
            }
            default -> respond(out, "404 Not Found", "", "");
        }
    }

    private static boolean same(String first, String second) {
        return MessageDigest.isEqual(first.getBytes(StandardCharsets.US_ASCII), second.getBytes(StandardCharsets.US_ASCII));
    }

    private void stream(OutputStream out) throws IOException {
        ascii(out, "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
        out.flush();
        long previous = -1;
        while (!closed) {
            byte[] jpeg;
            synchronized (this) {
                if (!closed && (latest == null || previous == serial)) {
                    try { wait(2_000); } catch (InterruptedException e) { return; }
                }
                if (closed) return;
                jpeg = latest;
                previous = serial;
            }
            if (jpeg == null) continue;
            ascii(out, "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + jpeg.length + "\r\n\r\n");
            out.write(jpeg);
            ascii(out, "\r\n");
            out.flush();
        }
    }

    private void streamAvc(OutputStream out) throws IOException {
        ascii(out, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
        out.flush();
        DataOutputStream packets = new DataOutputStream(out);
        long previous = -1;
        try {
            AvcFrames.Frame frame;
            while ((frame = avcFrames.after(previous)) != null) {
                frame.write(packets);
                previous = frame.sequence();
            }
        } catch (InterruptedException shutdown) {
            Thread.currentThread().interrupt();
        }
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (buffer.size() <= 4096) {
            int next = in.read();
            if (next == -1) throw new EOFException();
            if (next == '\n') return buffer.toString("US-ASCII").trim();
            buffer.write(next);
        }
        throw new IOException("header too long");
    }

    private static void ascii(OutputStream out, String value) throws IOException {
        out.write(value.getBytes(StandardCharsets.US_ASCII));
    }

    private static void respond(OutputStream out, String status, String headers, String body) throws IOException {
        respond(out, status, headers, body, "text/html; charset=utf-8");
    }

    private static void respond(OutputStream out, String status, String headers, String body, String mime) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ascii(out, "HTTP/1.1 " + status + "\r\n" + headers + "Content-Type: " + mime + "\r\n"
                + "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n"
                + "Content-Security-Policy: default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; "
                + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'\r\n"
                + "Connection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n");
        out.write(bytes);
        out.flush();
    }

    @Override public void close() {
        synchronized (this) {
            closed = true;
            latest = null;
            notifyAll();
        }
        avcFrames.close();
        try { listener.close(); } catch (IOException ignored) {}
        for (Socket socket : connected) {
            try { socket.close(); } catch (IOException ignored) {}
        }
        clients.shutdownNow();
    }
}
