package org.remotecontrol.share;

import static org.junit.Assert.*;
import org.junit.Test;

public final class TrackpadTest {
    @Test public void nativeAxesPreserveFractionsAndConvertPositiveUpToNegativeDomY() {
        assertEquals("0.25,0.75,0.003125,-0.0125",
                TrackpadWebView.wheelArguments(200, 300, 0.0625f, 0.125f, 40, 40, 800, 400));
        assertNull(TrackpadWebView.wheelArguments(0, 0, 0, 0, 40, 40, 800, 400));
        assertNull(TrackpadWebView.wheelArguments(0, 0, 1, 1, 40, 40, 0, 0));
        assertNull(TrackpadWebView.wheelArguments(Float.NaN, 0, 1, 1, 40, 40, 800, 400));
    }

    @Test public void viewerPinsSchemeHostnameAndPortAndRejectsHostCredentials() {
        String origin = DesktopOrigin.of("HTTPS://Desk.example:443/");
        assertEquals("https://desk.example", origin);
        assertTrue(DesktopOrigin.matches(origin, "https://desk.example/page?view"));
        assertFalse(DesktopOrigin.matches(origin, "http://desk.example/"));
        assertFalse(DesktopOrigin.matches(origin, "https://desk.example:8443/"));
        assertFalse(DesktopOrigin.matches(origin, "https://desk.example.evil.invalid/"));
        assertFalse(DesktopOrigin.matches(origin, "https://someone@desk.example/"));
        assertFalse(DesktopOrigin.matches(origin, "file:///local.html"));
        assertThrows(IllegalArgumentException.class, () -> DesktopOrigin.viewerUrl("https://desk.example/#host=credential"));
        assertEquals("https://192.168.1.10:8443/", DesktopOrigin.viewerUrl("https://192.168.1.10:8443"));
    }
}
