package com.codexpane.companion;

import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.*;
import okhttp3.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Explicit endpoint-only diagnostic. No credentials, pairing payload or chat is transmitted. */
public class NativeNetworkProbeTest {
    private void report(String value){Bundle b=new Bundle();b.putString("stream",value+"\n");InstrumentationRegistry.getInstrumentation().sendStatus(2,b);}
    @Test(timeout=45000) public void publicTlsAndWebSocketChallenge()throws Exception {
        String origin=InstrumentationRegistry.getArguments().getString("origin","");ConnectionUrl.validate(origin+"/");
        assertTrue("An explicit HTTPS endpoint is required",origin.startsWith("https://"));
        try(androidx.test.core.app.ActivityScenario<NativeChatActivity> foreground=androidx.test.core.app.ActivityScenario.launch(NativeChatActivity.class)) {
        OkHttpClient client=new OkHttpClient.Builder().dns(new ResilientDns()).eventListener(new EventListener(){public void dnsStart(Call c,String d){report("DNS_START");}public void dnsEnd(Call c,String d,java.util.List<java.net.InetAddress> ips){report("DNS_END addresses="+ips.size());}public void connectStart(Call c,java.net.InetSocketAddress a,java.net.Proxy p){report("CONNECT_START family="+(a.getAddress() instanceof java.net.Inet6Address?"v6":"v4"));}public void secureConnectStart(Call c){report("TLS_START");}}).connectTimeout(15,TimeUnit.SECONDS).readTimeout(15,TimeUnit.SECONDS).callTimeout(25,TimeUnit.SECONDS).build();
        long start=System.currentTimeMillis();
        try(Response response=client.newCall(new Request.Builder().url(origin+"/health").build()).execute()){
            report("HTTPS status="+response.code()+" elapsedMs="+(System.currentTimeMillis()-start));assertTrue(response.isSuccessful());
        }catch(Exception e){report("HTTPS error="+e.getClass().getSimpleName()+" elapsedMs="+(System.currentTimeMillis()-start));throw e;}
        CountDownLatch done=new CountDownLatch(1);boolean[] challenge={false};long wsStart=System.currentTimeMillis();
        WebSocket ws=client.newWebSocket(new Request.Builder().url("wss"+origin.substring(5)+"/ws").header("Origin",origin).build(),new WebSocketListener(){
            public void onMessage(WebSocket socket,String text){challenge[0]=text.contains("relay.challenge");report("WS challenge="+challenge[0]+" elapsedMs="+(System.currentTimeMillis()-wsStart));socket.close(1000,"Diagnostic complete");done.countDown();}
            public void onFailure(WebSocket socket,Throwable error,Response response){report("WS error="+error.getClass().getSimpleName()+" status="+(response==null?"none":response.code())+" elapsedMs="+(System.currentTimeMillis()-wsStart));done.countDown();}
        });
        try{assertTrue("WebSocket deadline",done.await(30,TimeUnit.SECONDS));assertTrue("Relay challenge expected",challenge[0]);}finally{ws.cancel();client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}
        }
    }
}
