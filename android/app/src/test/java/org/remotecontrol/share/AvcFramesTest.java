package org.remotecontrol.share;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import org.junit.Test;
import static org.junit.Assert.*;

public class AvcFramesTest {
    @Test public void lateAndSlowReadersStartAtLastKeyframe() throws Exception {
        AvcFrames stream = new AvcFrames();
        stream.publish(10, false, new byte[]{1});
        stream.publish(20, true, new byte[]{2});
        stream.publish(30, false, new byte[]{3});
        AvcFrames.Frame first = stream.after(-1);
        assertEquals(20, first.timeUs());
        assertTrue(first.key());
        AvcFrames.Frame next = stream.after(first.sequence());
        assertFalse(next.key());
        stream.publish(40, true, new byte[]{4});
        assertEquals(40, stream.after(first.sequence()).timeUs());
        assertEquals(40, stream.after(-1).timeUs());
        stream.close();
        assertNull(stream.after(next.sequence()));
    }

    @Test public void restartDropsUndecodableFramesAndTimestampIsBigEndian() throws Exception {
        AvcFrames stream = new AvcFrames();
        stream.publish(100, true, new byte[]{42});
        long old = stream.after(-1).sequence();
        stream.reset();
        stream.publish(0, false, new byte[]{1});
        stream.publish(33000, true, new byte[]{3, 4});
        AvcFrames.Frame frame = stream.after(old);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        frame.write(new DataOutputStream(bytes));
        assertArrayEquals(new byte[]{0,0,0,2, 0,0,0,0,0,0,(byte)128,(byte)232, 1, 3,4}, bytes.toByteArray());
    }

    @Test public void convertsLengthPrefixedAndRawNalsToAnnexB() {
        byte[] prefixed = {0,0,0,2,0x67,0x42, 0,0,0,1,0x68};
        byte[] expected = {0,0,0,1,0x67,0x42, 0,0,0,1,0x68};
        assertArrayEquals(expected, AvcFrames.annexB(prefixed));
        assertArrayEquals(new byte[]{0,0,0,1,0x68}, AvcFrames.annexB(new byte[]{0x68}));
        assertArrayEquals(expected, AvcFrames.annexB(expected));
    }
}
