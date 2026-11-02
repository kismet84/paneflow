package com.codexpane.companion;
import android.app.KeyguardManager;
import android.content.Context;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class NativeReadOnlyLiveTest {
    private void main(Runnable r){InstrumentationRegistry.getInstrumentation().runOnMainSync(r);}
    private void report(String value){Bundle b=new Bundle();b.putString("stream",value+"\n");InstrumentationRegistry.getInstrumentation().sendStatus(0,b);}
    @Test public void publicExternalWriterStreamsReadOnlyHistory()throws Exception {
        Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("liveReadOnly")));
        String thread=args.getString("threadId","");assertFalse(thread.isEmpty());String marker=args.getString("marker","");assertFalse(marker.isEmpty());
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){
            NativeConnection c=NativeConnections.get(context).find("legacy");assertNotNull(c);
            long end=System.currentTimeMillis()+60000;
            while((!c.authenticated||!c.supports("independentSessions")||c.lastSnapshotAt==0)&&System.currentTimeMillis()<end)Thread.sleep(100);
            assertTrue(c.authenticated);
            scenario.onActivity(a->{try{Method m=NativeChatActivity.class.getDeclaredMethod("openThread",String.class);m.setAccessible(true);m.invoke(a,thread);}catch(Exception e){throw new AssertionError(e);}});
            while(System.currentTimeMillis()<end){AtomicReference<Boolean> ready=new AtomicReference<>(false);main(()->ready.set(thread.equals(c.snapshot.optString("activeThreadId"))&&c.readOnly()));if(ready.get())break;Thread.sleep(100);}
            main(()->{assertEquals(thread,c.snapshot.optString("activeThreadId"));assertTrue(c.readOnly());});
            AtomicReference<Long> first=new AtomicReference<>();main(()->first.set(c.snapshot.optLong("readOnlyUpdatedAt")));report("READONLY_READY");
            main(()->{try{c.command(NativeConnection.obj("type","history.list","threadId",thread,"limit",5));}catch(Exception e){throw new AssertionError(e);}});
            boolean found=false;end=System.currentTimeMillis()+90000;
            while(System.currentTimeMillis()<end){AtomicReference<Boolean> result=new AtomicReference<>(false);main(()->{JSONArray items=c.snapshot.optJSONArray("items");if(items!=null)for(int i=0;i<items.length();i++){JSONObject item=items.optJSONObject(i);if(item!=null&&"agent".equals(item.optString("kind"))&&item.optString("markdown").contains(marker)&&c.snapshot.optLong("readOnlyUpdatedAt")>first.get())result.set(true);}});if(result.get()){found=true;break;}Thread.sleep(200);}
            assertTrue("New desktop agent message did not sync",found);report("READONLY_NEW_AGENT_MESSAGE_SYNCED");
            main(()->{assertTrue(c.readOnly());assertEquals(thread,c.snapshot.optString("activeThreadId"));});
            assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
        }
    }
    @Test public void readonlyHistoryCanLoadTwoPages()throws Exception {
        Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("liveReadOnlyHistory")));
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)) {
            NativeConnection c=NativeConnections.get(context).find("legacy");assertNotNull(c);
            long until=System.currentTimeMillis()+60000;
            while((!c.authenticated||!c.readOnly())&&System.currentTimeMillis()<until)Thread.sleep(100);
            assertTrue(c.readOnly());String thread=c.snapshot.optString("activeThreadId");assertEquals(args.getString("threadId"),thread);
            java.util.concurrent.BlockingQueue<JSONObject> events=new java.util.concurrent.LinkedBlockingQueue<>();NativeConnection.Listener listener=e->{events.offer(e);};
            main(()->c.add(listener));String cursor="";java.util.Set<String> ids=new java.util.HashSet<>();
            try {for(int page=0;page<2;page++) {
                JSONObject request=NativeConnection.obj("type","history.list","threadId",thread,"limit",20);if(!cursor.isEmpty())request.put("cursor",cursor);
                AtomicReference<String> id=new AtomicReference<>();main(()->{try{id.set(c.command(request));}catch(Exception e){throw new AssertionError(e);}});
                JSONObject result=null;until=System.currentTimeMillis()+30000;
                while(System.currentTimeMillis()<until){JSONObject e=events.poll(1,java.util.concurrent.TimeUnit.SECONDS);if(e==null||!id.get().equals(e.optString("requestId")))continue;if("command.result".equals(e.optString("type")))assertTrue(e.optString("message"),e.optBoolean("ok"));if("history.page".equals(e.optString("type"))){result=e;break;}}
                assertNotNull("History page unavailable",result);JSONArray items=result.getJSONArray("items");assertTrue(items.length()>0);for(int i=0;i<items.length();i++)assertTrue("Duplicate item between pages",ids.add(items.getJSONObject(i).getString("id")));cursor=result.optString("nextCursor","");assertFalse(cursor.isEmpty());
            }report("READONLY_TWO_HISTORY_PAGES_OK items="+ids.size());}finally{main(()->c.remove(listener));}
        }
    }

}
