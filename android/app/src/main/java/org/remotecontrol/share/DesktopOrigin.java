package org.remotecontrol.share;

import java.net.URI;
import java.util.Locale;

final class DesktopOrigin {
    static String of(String address) {
        if (address == null) throw new IllegalArgumentException();
        URI uri = URI.create(address);
        int port = uri.getPort();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || port == 0 || port > 65535) throw new IllegalArgumentException();
        return "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (port < 0 || port == 443 ? "" : ":" + port);
    }

    static String viewerUrl(String address) {
        String origin = of(address);
        URI uri = URI.create(address);
        if (uri.getRawFragment() != null) throw new IllegalArgumentException();
        String path = uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
        return origin + path + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
    }

    static boolean matches(String origin, String address) {
        try { return origin.equals(of(address)); }
        catch (IllegalArgumentException error) { return false; }
    }
}
