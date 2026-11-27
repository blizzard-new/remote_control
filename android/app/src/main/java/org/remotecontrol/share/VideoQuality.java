package org.remotecontrol.share;

/** Preferences sent by a viewer. Legacy viewers receive one JPEG per relay message. */
enum VideoQuality {
    LEGACY(340000, 88, 72, 54, 36),
    BALANCED(8 * 1024 * 1024, 80, 72),
    SHARP(8 * 1024 * 1024, 95, 88, 78);

    static final int MAX_EDGE = 3840;
    static final int[] EDGES = {960, 1280, 1920, 2560, MAX_EDGE};
    static final int SINGLE_IMAGE = 340000;
    static final int PIECE_BYTES = 220000;
    static final int SHARP_BIT = 1 << 20;
    final int maxBytes;
    final int[] levels;

    VideoQuality(int maxBytes, int... levels) {
        this.maxBytes = maxBytes;
        this.levels = levels;
    }

    static int edge(int request) {
        for (int supported : EDGES) if (request == supported) return request;
        return 1920;
    }

    static int codecProfile(int edge, int fps, VideoQuality quality) {
        return edge * 100 + fps + (quality == SHARP ? SHARP_BIT : 0);
    }
}
