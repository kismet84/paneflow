package com.codexpane.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import okhttp3.WebSocket;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.lang.reflect.Field;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Explicit public read-only transport fault test. Never manually reconnects or submits work. */
@RunWith(AndroidJUnit4.class)
public class NativePublicReconnectTest {
    private final BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
    private final AtomicBoolean faultInjected=new AtomicBoolean(),sawOffline=new AtomicBoolean();
    private NativeConnection connection;
    private final NativeConnection.Listener listener=event->{events.offer(event);if(faultInjected.get()&&connection!=null&&!connection.authenticated)sawOffline.set(true);};
    private NativeChatActivity activity;
    private String thread,phase="preflight";
    private long totalDeadline;
    private Field socketField;

    private void main(Runnable action){InstrumentationRegistry.getInstrumentation().runOnMainSync(action);}
    private long stepDeadline(){return Math.min(totalDeadline,System.currentTimeMillis()+45000);}
    private void phase(String name){phase=name;Bundle status=new Bundle();status.putString("phase",name);status.putString("threadId",thread);InstrumentationRegistry.getInstrumentation().sendStatus(0,status);}
    private void assertUnlocked(){Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();KeyguardManager keyguard=context.getSystemService(KeyguardManager.class);PowerManager power=context.getSystemService(PowerManager.class);assertNotNull(keyguard);assertNotNull(power);assertFalse("Device must already be unlocked",keyguard.isKeyguardLocked());assertFalse("Device authentication required",keyguard.isDeviceLocked());assertTrue("Display must already be interactive",power.isInteractive());}
    private WebSocket socket(){try{return (WebSocket)socketField.get(connection);}catch(IllegalAccessException e){throw new AssertionError("Socket inspection unavailable");}}
    private void initialReady()throws Exception{long until=stepDeadline();while(System.currentTimeMillis()<until){AtomicBoolean ready=new AtomicBoolean();main(()->ready.set(connection.authenticated&&connection.supports("attachmentsV1")&&connection.supports("historyPagination")&&"ready".equals(connection.snapshot.optString("codexState"))));if(ready.get())return;Thread.sleep(100);}throw new AssertionError("Existing public connection unavailable");}
    private JSONObject request(JSONObject command,String expected,long until)throws Exception{
        if(System.currentTimeMillis()>=totalDeadline)throw new AssertionError("Total reconnect deadline reached");
        String type=command.optString("type");assertTrue("Read-only request boundary",type.equals("thread.open")||type.equals("history.list"));String id=UUID.randomUUID().toString();command.put("requestId",id);AtomicReference<Exception> failure=new AtomicReference<>();main(()->{try{connection.command(command);}catch(Exception e){failure.set(e);}});if(failure.get()!=null)throw new AssertionError("Read-only request unavailable");
        long end=Math.min(totalDeadline,Math.min(until,System.currentTimeMillis()+45000));while(System.currentTimeMillis()<end){JSONObject event=events.poll(200,TimeUnit.MILLISECONDS);if(event==null||!id.equals(event.optString("requestId")))continue;if("command.result".equals(event.optString("type"))&&!event.optBoolean("ok"))throw new AssertionError("Read-only request rejected");if(expected.equals(event.optString("type")))return event;}throw new AssertionError("Read-only response timeout");
    }
    private static final class History {final Set<String> items=new HashSet<>(),attachments=new HashSet<>();}
    private History completeHistory()throws Exception{
        History result=new History();String cursor=null;Set<String> cursors=new HashSet<>();long until=stepDeadline();
        do{JSONObject command=NativeConnection.obj("type","history.list","threadId",thread,"limit",20);if(cursor!=null)command.put("cursor",cursor);JSONObject page=request(command,"history.page",until);assertEquals(thread,page.getString("threadId"));JSONArray items=page.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);String id=item.getString("id");assertFalse(id.isEmpty());result.items.add(id);JSONArray attachments=item.optJSONArray("attachments");if(attachments!=null)for(int j=0;j<attachments.length();j++)result.attachments.add(attachments.getJSONObject(j).getString("id"));}cursor=page.isNull("nextCursor")?null:page.optString("nextCursor",null);if(cursor!=null&&cursor.isEmpty())cursor=null;if(cursor!=null)assertTrue("History cursor did not advance",cursors.add(cursor));assertTrue("Unexpected validation history size",result.items.size()<=2000);if(System.currentTimeMillis()>=until&&cursor!=null)throw new AssertionError("Complete history deadline reached");}while(cursor!=null);return result;
    }
    @Test public void socketFailureAutomaticallyRestoresPublicSessionAndCompleteHistory()throws Exception{
        Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("livePublicReconnect")));thread=args.getString("threadId","");assertEquals("Explicit UUID thread required",UUID.fromString(thread).toString(),thread);totalDeadline=System.currentTimeMillis()+120000;assertUnlocked();phase("autoReconnect.preflight");socketField=NativeConnection.class.getDeclaredField("socket");socketField.setAccessible(true);
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class);
        try{
            scenario.onActivity(screen->{activity=screen;assertUnlocked();screen.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);connection=NativeConnections.get(context).find("legacy");assertNotNull("Existing production binding required",connection);assertTrue(connection.paired());assertEquals(InstrumentationRegistry.getArguments().getString("expectedPublicOrigin", ""),connection.relay());connection.add(listener);});
            initialReady();phase("autoReconnect.open.validation.thread");request(NativeConnection.obj("type","thread.open","threadId",thread),"command.result",stepDeadline());
            long selectedUntil=stepDeadline();while(System.currentTimeMillis()<selectedUntil){AtomicBoolean selected=new AtomicBoolean();main(()->selected.set(thread.equals(connection.snapshot.optString("activeThreadId"))&&"idle".equals(connection.snapshot.optString("turnStatus"))));if(selected.get())break;Thread.sleep(100);}main(()->{assertEquals(thread,connection.snapshot.optString("activeThreadId"));assertEquals("idle",connection.snapshot.optString("turnStatus"));});
            phase("autoReconnect.history.before");History before=completeHistory();assertFalse("Validation history must exist",before.items.isEmpty());
            if(!"false".equals(args.getString("requireAttachments")))assertTrue("Validation history must contain both attachments",before.attachments.size()>=2);
            Bundle counts=new Bundle();counts.putInt("historyItems",before.items.size());counts.putInt("historyAttachments",before.attachments.size());InstrumentationRegistry.getInstrumentation().sendStatus(0,counts);
            AtomicReference<WebSocket> oldSocket=new AtomicReference<>();AtomicReference<Long> oldSnapshot=new AtomicReference<>();phase("autoReconnect.cancel.socket.only");main(()->{oldSocket.set(socket());assertNotNull(oldSocket.get());oldSnapshot.set(connection.lastSnapshotAt);faultInjected.set(true);oldSocket.get().cancel();});
            long recoveredUntil=stepDeadline();boolean recovered=false;while(System.currentTimeMillis()<recoveredUntil){AtomicBoolean ready=new AtomicBoolean();main(()->ready.set(sawOffline.get()&&connection.authenticated&&socket()!=null&&socket()!=oldSocket.get()&&connection.lastSnapshotAt>oldSnapshot.get()&&thread.equals(connection.snapshot.optString("activeThreadId"))&&connection.supports("attachmentsV1")&&"idle".equals(connection.snapshot.optString("turnStatus"))));if(ready.get()){recovered=true;break;}Thread.sleep(100);}assertTrue("Automatic recovery and selection restoration failed",recovered);phase("autoReconnect.automatic.authentication.restored");
            // Recovery and the following history comparison happen without any manual recovery command.
            // Ordinary OPEN_CHAT navigation is performed only after verification succeeds.
            assertEquals(InstrumentationRegistry.getArguments().getString("expectedPublicOrigin", ""),connection.relay());phase("autoReconnect.history.after");History after=completeHistory();assertEquals("Item IDs changed across reconnect",before.items,after.items);assertEquals("Attachment IDs changed across reconnect",before.attachments,after.attachments);assertUnlocked();
            main(()->activity.onNewIntent(new Intent().setAction("com.codexpane.OPEN_CHAT").putExtra("computerId","legacy").putExtra("threadId",thread)));phase("autoReconnect.complete");
        }catch(Throwable error){AtomicReference<String> detail=new AtomicReference<>("");main(()->{if(connection!=null)detail.set(connection.diagnostics().toString()+" status="+connection.status);});throw new AssertionError("Public automatic reconnect verification failed at "+phase+"; "+detail.get(),error);}
        finally{main(()->{if(connection!=null)connection.remove(listener);if(activity!=null)activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);});/* Shared connection and ordinary chat remain available. */}
    }
}
