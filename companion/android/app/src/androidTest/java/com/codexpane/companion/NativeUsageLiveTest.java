package com.codexpane.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Method;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import static org.junit.Assert.*;

/** Opt-in live read-only verification; keeps the usage screen open for a screenshot. */
public class NativeUsageLiveTest {
    private static ActivityScenario<NativeChatActivity> displayedScenario;
    private void main(Runnable task){InstrumentationRegistry.getInstrumentation().runOnMainSync(task);}
    private void report(String value){Bundle result=new Bundle();result.putString("stream",value+"\n");InstrumentationRegistry.getInstrumentation().sendStatus(0,result);}
    private boolean ready(NativeConnection c){AtomicReference<Boolean> value=new AtomicReference<>(false);main(()->value.set(c.authenticated&&c.supports("usageSummary")&&c.lastSnapshotAt>0));return value.get();}
    private void navigate(NativeChatActivity activity,String route)throws Exception{Method method=NativeChatActivity.class.getDeclaredMethod("navigate",String.class);method.setAccessible(true);method.invoke(activity,route);}
    @Test public void readsPublicUsageAndLeavesSettingsScreenOpen()throws Exception {
        Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("liveUsage")));
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();KeyguardManager keyguard=context.getSystemService(KeyguardManager.class);assertNotNull(keyguard);assertFalse("Device must already be unlocked",keyguard.isKeyguardLocked());
        displayedScenario=ActivityScenario.launch(NativeChatActivity.class);
        NativeConnection connection=NativeConnections.get(context).find("legacy");assertNotNull("Existing legacy binding required",connection);assertTrue(connection.paired());
        long deadline=System.currentTimeMillis()+60000;while(!ready(connection)&&System.currentTimeMillis()<deadline)Thread.sleep(100);assertTrue("Authenticated usageSummary-capable desktop required",ready(connection));
        if("true".equals(args.getString("reconnect"))){long previous=connection.lastSnapshotAt;main(connection::reconnect);deadline=System.currentTimeMillis()+60000;while((!ready(connection)||connection.lastSnapshotAt<=previous)&&System.currentTimeMillis()<deadline)Thread.sleep(100);assertTrue("Reconnect failed",ready(connection));assertTrue(connection.lastSnapshotAt>previous);report("PUBLIC_RECONNECT_OK");}
        BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();NativeConnection.Listener listener=events::offer;main(()->connection.add(listener));
        try {
            String target=args.getString("threadId","");if(!target.isEmpty())verifyRuntime(connection,target,args.getString("expectedStatus","running"));
            AtomicReference<String> request=new AtomicReference<>();
            displayedScenario.onActivity(activity->{try{
                Method select=NativeChatActivity.class.getDeclaredMethod("selectComputer",NativeConnection.class);select.setAccessible(true);select.invoke(activity,connection);
                navigate(activity,"settings");navigate(activity,"usage");request.set(connection.usageRequest);
            }catch(Exception error){throw new AssertionError(error);}});
            assertNotNull(request.get());assertFalse("Usage read was not dispatched",request.get().isEmpty());
            JSONObject received=null;deadline=System.currentTimeMillis()+20000;
            while(System.currentTimeMillis()<deadline){JSONObject event=events.poll(1,TimeUnit.SECONDS);if(event==null||!request.get().equals(event.optString("requestId")))continue;if("command.result".equals(event.optString("type")))assertTrue("Usage command rejected",event.optBoolean("ok"));if("usage.snapshot".equals(event.optString("type"))){received=event.getJSONObject("usage");break;}}
            assertNotNull("No correlated usage snapshot",received);assertTrue(received.optLong("updatedAt",0)>0);
            JSONArray windows=received.optJSONArray("windows");assertNotNull(windows);
            if(received.optBoolean("limitsAvailable"))assertTrue("Available limits need a window",windows.length()>0);else assertFalse("Unavailable limits need an explanation",received.optString("limitsError","").isEmpty());
            if(!received.optBoolean("tokensAvailable"))assertFalse("Unavailable token summary needs an explanation",received.optString("tokensError","").isEmpty());
            if("true".equals(args.getString("requireLimits"))){assertTrue("Real account quota unavailable",received.optBoolean("limitsAvailable"));for(int i=0;i<windows.length();i++){JSONObject w=windows.getJSONObject(i);assertTrue(w.getDouble("usedPercent")>=0&&w.getDouble("usedPercent")<=100);assertTrue("Reset timestamp required",w.optLong("resetsAt")>0);}report("PUBLIC_QUOTA_OK "+windows.toString());}
            JSONObject safe=NativeConnection.obj("updatedAt",received.optLong("updatedAt"),"limitsAvailable",received.optBoolean("limitsAvailable"),"windowCount",windows.length(),"tokensAvailable",received.optBoolean("tokensAvailable"));
            for(String field:new String[]{"lifetimeTokens","peakDailyTokens","currentStreakDays","estimatedUsdMicros"})if(received.opt(field) instanceof Number)NativeConnection.put(safe,field,received.opt(field));
            report("PUBLIC_USAGE_READ_OK "+safe.toString());
            displayedScenario.onActivity(activity->{try{Method render=NativeChatActivity.class.getDeclaredMethod("renderUsage");render.setAccessible(true);render.invoke(activity);}catch(Exception error){throw new AssertionError(error);}});
            Thread.sleep(500);
            android.graphics.Bitmap image=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            try(java.io.FileOutputStream output=new java.io.FileOutputStream(new java.io.File(context.getExternalFilesDir(null),"usage-live.png"))){assertNotNull(image);image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,output);}
            assertFalse("Test must not lock the phone",keyguard.isKeyguardLocked());
        } finally {main(()->connection.remove(listener));}
        // Deliberately no close(): the caller captures the actual rendered usage page.
    }
    private void verifyRuntime(NativeConnection connection,String target,String expected)throws Exception {
        long deadline=System.currentTimeMillis()+20000,nextRefresh=0;String observed="missing";
        while(System.currentTimeMillis()<deadline){
            if(System.currentTimeMillis()>=nextRefresh){main(()->{try{connection.command(NativeConnection.obj("type","snapshot.get"));}catch(Exception error){throw new AssertionError(error);}});nextRefresh=System.currentTimeMillis()+2000;}
            AtomicReference<String> value=new AtomicReference<>("missing");main(()->{JSONArray threads=connection.snapshot.optJSONArray("threads");if(threads!=null)for(int i=0;i<threads.length();i++){JSONObject row=threads.optJSONObject(i);if(row!=null&&target.equals(row.optString("id")))value.set(row.optString("status","unknown"));}});observed=value.get();if(expected.equals(observed)){report("EXTERNAL_RUNTIME_STATUS_OK status="+observed);return;}Thread.sleep(200);
        }
        assertEquals("Target runtime status did not converge",expected,observed);
    }
}
