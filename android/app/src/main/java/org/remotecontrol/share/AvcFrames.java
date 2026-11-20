package org.remotecontrol.share;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;

/** One bounded, decodable group of pictures shared by all HTTPS readers. */
final class AvcFrames {
    static final int MAX_FRAME = 4 * 1024 * 1024;
    record Frame(long sequence, long timeUs, boolean key, byte[] data) {
        void write(DataOutputStream out) throws IOException {
            out.writeInt(data.length);
            out.writeLong(timeUs);
            out.writeByte(key ? 1 : 0);
            out.write(data);
            out.flush();
        }
    }

    private final ArrayList<Frame> group = new ArrayList<>();
    private int bytes;
    private long sequence;
    private boolean closed;

    synchronized void reset() {
        group.clear();
        bytes = 0;
    }

    synchronized void publish(long timeUs, boolean key, byte[] data) {
        if (closed) return;
        if (key) reset();
        if (data.length == 0 || data.length > MAX_FRAME || bytes + data.length > 6 * 1024 * 1024
                || group.size() >= 120) {
            reset();
            return;
        }
        if (!key && group.isEmpty()) return;
        group.add(new Frame(++sequence, timeUs, key, data));
        bytes += data.length;
        notifyAll();
    }

    synchronized Frame after(long previous) throws InterruptedException {
        while (!closed && (group.isEmpty() || group.get(group.size() - 1).sequence() <= previous)) wait();
        if (closed) return null;
        int index = (int) Math.max(0, previous + 1 - group.get(0).sequence());
        return group.get(index);
    }

    synchronized void close() {
        closed = true;
        reset();
        notifyAll();
    }

    /** Android AVC implementations may return either start codes or native NAL length fields. */
    static byte[] annexB(byte[] input) {
        if (input.length == 0 || (input.length >= 3 && input[0] == 0 && input[1] == 0
                && (input[2] == 1 || (input.length >= 4 && input[2] == 0 && input[3] == 1)))) return input;
        ByteArrayOutputStream converted = new ByteArrayOutputStream(input.length + 4);
        for (int offset = 0; offset < input.length;) {
            if (input.length - offset < 4) return singleNal(input);
            int length = ((input[offset] & 255) << 24) | ((input[offset + 1] & 255) << 16)
                    | ((input[offset + 2] & 255) << 8) | (input[offset + 3] & 255);
            offset += 4;
            if (length <= 0 || length > input.length - offset) return singleNal(input);
            converted.write(0); converted.write(0); converted.write(0); converted.write(1);
            converted.write(input, offset, length);
            offset += length;
        }
        return converted.toByteArray();
    }

    private static byte[] singleNal(byte[] unit) {
        byte[] out = new byte[4 + unit.length];
        out[3] = 1;
        System.arraycopy(unit, 0, out, 4, unit.length);
        return out;
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
