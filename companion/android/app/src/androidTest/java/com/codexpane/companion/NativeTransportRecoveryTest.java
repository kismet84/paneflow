package com.codexpane.companion;

import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;

/** Closed transport retries; invalid identity/protocol never silently retries. */
public class NativeTransportRecoveryTest {
    @org.junit.ClassRule public static NativeTestCpuRule cpu = new NativeTestCpuRule();
    private static void set(NativeConnection c,String name,Object value)throws Exception{java.lang.reflect.Field f=NativeConnection.class.getDeclaredField(name);f.setAccessible(true);f.set(c,value);}
    private static boolean stopped(NativeConnection c)throws Exception{java.lang.reflect.Field f=NativeConnection.class.getDeclaredField("stopped");f.setAccessible(true);return f.getBoolean(c);}
    @Test public void closedSocketSchedulesReconnectButStaleCallbacksCannotRejectIt()throws Exception{
        NativeConnection c=new NativeConnection(InstrumentationRegistry.getInstrumentation().getTargetContext(),"transport-test-"+java.util.UUID.randomUUID());
        try{set(c,"stopped",false);set(c,"generation",7);c.authenticated=true;c.receiveFailure(7,new NativeConnection.TransportUnavailableException());assertFalse(c.authenticated);assertFalse(stopped(c));assertTrue(c.status.contains("正在重连"));c.receiveFailure(7,new SecurityException("stale"));assertFalse(stopped(c));assertTrue(c.status.contains("正在重连"));}finally{c.dispose();c.local.clear();}
    }
    @Test public void signatureFailureStopsInsteadOfRetrying()throws Exception{
        NativeConnection c=new NativeConnection(InstrumentationRegistry.getInstrumentation().getTargetContext(),"transport-test-"+java.util.UUID.randomUUID());
        try{set(c,"stopped",false);set(c,"generation",7);c.authenticated=true;c.receiveFailure(7,new SecurityException("桌面身份不匹配"));assertFalse(c.authenticated);assertTrue(stopped(c));assertTrue(c.status.contains("桌面身份不匹配"));}finally{c.dispose();c.local.clear();}
    }
}
