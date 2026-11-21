package org.remotecontrol.share;

import java.net.Inet4Address;
import java.net.InetAddress;

final class ShareNetwork {
    private ShareNetwork() {}

    static boolean privateAddress(InetAddress address) {
        if (!(address instanceof Inet4Address)) return false;
        if (address.isSiteLocalAddress() || address.isLinkLocalAddress()) return true;
        // Peer-to-peer VPNs commonly assign IPv4 addresses from RFC 6598 (100.64.0.0/10).
        byte[] bytes = address.getAddress();
        return bytes[0] == 100 && (bytes[1] & 0xc0) == 0x40;
    }
}
