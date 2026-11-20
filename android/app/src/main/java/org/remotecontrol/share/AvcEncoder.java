package org.remotecontrol.share;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.view.Surface;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.function.Consumer;

/** Surface-input screen encoder. All codec callbacks and projection changes share the capture looper. */
final class AvcEncoder implements AutoCloseable {
    final int width, height;
    final Surface surface;
    private final MediaCodec codec;
    private boolean closed;
    private byte[] config = new byte[0];

    static AvcEncoder open(int sourceWidth, int sourceHeight, Handler handler, AvcFrames frames,
                           Consumer<String> failed) {
        MediaCodecList codecs = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
        RuntimeException last = null;
        for (int shortEdge : new int[]{1080, 720, 540}) {
            double scale = Math.min(1d, Math.min(shortEdge / (double) Math.min(sourceWidth, sourceHeight),
                    (shortEdge * 16d / 9d) / Math.max(sourceWidth, sourceHeight)));
            int w = dimension(sourceWidth * scale);
            int h = dimension(sourceHeight * scale);
            MediaFormat format = MediaFormat.createVideoFormat("video/avc", w, h);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
            format.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(1_000_000, w * h * 4));
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
            // Refresh even a stationary desktop so new viewers can acquire a keyframe.
            format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000);
            if (Build.VERSION.SDK_INT >= 29) {
                format.setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, 30f);
                format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
            }
            String name = preferredEncoder(codecs, format);
            if (name == null) continue;
            try {
                return new AvcEncoder(name, format, w, h, handler, frames, failed);
            } catch (IOException | RuntimeException e) {
                last = new IllegalStateException(e);
            }
        }
        throw new IllegalStateException("找不到可用的 H.264 編碼器。請重新選擇相容模式。", last);
    }

    private static int dimension(double size) {
        int rounded = (int) Math.round(size);
        return rounded == 1080 || rounded == 540 ? rounded : Math.max(16, rounded / 16 * 16);
    }

    private static String preferredEncoder(MediaCodecList codecs, MediaFormat format) {
        if (Build.VERSION.SDK_INT >= 29) {
            for (MediaCodecInfo info : codecs.getCodecInfos()) {
                if (!info.isEncoder() || !info.isHardwareAccelerated()) continue;
                for (String type : info.getSupportedTypes()) {
                    if ("video/avc".equalsIgnoreCase(type) && info.getCapabilitiesForType(type).isFormatSupported(format)) {
                        return info.getName();
                    }
                }
            }
        }
        return codecs.findEncoderForFormat(format);
    }

    private AvcEncoder(String name, MediaFormat format, int w, int h, Handler handler,
                       AvcFrames frames, Consumer<String> failed) throws IOException {
        width = w;
        height = h;
        codec = MediaCodec.createByCodecName(name);
        Surface input = null;
        try {
            codec.setCallback(new MediaCodec.Callback() {
                @Override public void onInputBufferAvailable(MediaCodec owner, int index) {}
                @Override public void onError(MediaCodec owner, MediaCodec.CodecException error) {
                    if (!closed) failed.accept("H.264 編碼器已中止，請重新分享或改用相容模式。");
                }
                @Override public void onOutputFormatChanged(MediaCodec owner, MediaFormat next) {
                    if (!closed) config = AvcFrames.concat(read(next.getByteBuffer("csd-0")), read(next.getByteBuffer("csd-1")));
                }
                @Override public void onOutputBufferAvailable(MediaCodec owner, int index, MediaCodec.BufferInfo info) {
                    if (closed) return;
                    try {
                        ByteBuffer buffer = owner.getOutputBuffer(index);
                        if (buffer == null || info.size <= 0) return;
                        buffer.position(info.offset).limit(info.offset + info.size);
                        byte[] accessUnit = read(buffer);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            if (config.length == 0) config = accessUnit;
                        } else {
                            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                            frames.publish(info.presentationTimeUs, key, key ? AvcFrames.concat(config, accessUnit) : accessUnit);
                        }
                    } catch (RuntimeException failure) {
                        failed.accept("讀取 H.264 畫格失敗，請重新分享。");
                    } finally {
                        owner.releaseOutputBuffer(index, false);
                    }
                }
            }, handler);
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            input = codec.createInputSurface();
            codec.start();
        } catch (RuntimeException failure) {
            closed = true;
            try { codec.release(); } finally { if (input != null) input.release(); }
            throw failure;
        }
        surface = input;
    }

    private static byte[] read(ByteBuffer input) {
        if (input == null) return new byte[0];
        ByteBuffer copy = input.duplicate();
        byte[] data = new byte[copy.remaining()];
        copy.get(data);
        return AvcFrames.annexB(data);
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        try { codec.release(); } finally { surface.release(); }
    }
}
