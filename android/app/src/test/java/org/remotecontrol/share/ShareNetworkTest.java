package org.remotecontrol.share;

import static org.junit.Assert.*;
import java.net.InetAddress;
import org.junit.Test;

public class ShareNetworkTest {
    @Test public void selectsPrivateWifiAndVpnAddressesOnly() throws Exception {
        for (String address : new String[]{"10.12.34.1", "172.16.0.1", "192.168.0.5", "169.254.4.1",
                "100.64.0.0", "100.127.255.255"}) {
            assertTrue(address, ShareNetwork.privateAddress(InetAddress.getByName(address)));
        }
        for (String address : new String[]{"0.0.0.0", "127.0.0.1", "8.8.8.8", "100.63.255.255",
                "100.128.0.0", "172.32.0.1", "224.0.0.1", "fd00::1"}) {
            assertFalse(address, ShareNetwork.privateAddress(InetAddress.getByName(address)));
        }
    }
}
