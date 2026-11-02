package com.codexpane.companion;
import java.net.*;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
public class ResilientDnsTest {
    @Test public void avoidsAnUnreachableV6RouteBlockingAvailableV4AndKeepsAllFallbacks()throws Exception {
        InetAddress v6=InetAddress.getByAddress(new byte[16]),v4=InetAddress.getByAddress(new byte[]{127,0,0,1}),v42=InetAddress.getByAddress(new byte[]{127,0,0,2});
        List<InetAddress> source=Arrays.asList(v6,v4,v42);
        assertEquals(Arrays.asList(v4,v42,v6),ResilientDns.preferIpv4(source));
        assertEquals(Arrays.asList(v6,v4,v42),source);
        assertEquals(Collections.singletonList(v6),ResilientDns.preferIpv4(Collections.singletonList(v6)));
    }
}
