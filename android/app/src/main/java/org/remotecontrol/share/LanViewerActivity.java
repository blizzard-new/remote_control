package org.remotecontrol.share;

/** Explicit advanced LAN viewer. All launcher entries open the device dashboard. */
public final class LanViewerActivity extends DesktopViewerActivity {
    @Override protected boolean onlineMode() {
        return false;
    }
}
