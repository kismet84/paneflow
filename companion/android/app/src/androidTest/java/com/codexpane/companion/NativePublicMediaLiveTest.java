package com.codexpane.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Base64;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Opt-in real public regression. Never pairs, unlocks, changes endpoints or retries a turn. */
@RunWith(AndroidJUnit4.class)
public class NativePublicMediaLiveTest {
    private static final String ORIGIN=InstrumentationRegistry.getArguments().getString("expectedPublicOrigin", "");
    private static final String CWD="D:/projects-test/paneflow-public/outputs/stage-0.8-public/workspace";
    private final BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
    private final NativeConnection.Listener listener=event->events.offer(event);
    private NativeConnection connection;
    private NativeChatActivity activity;
    private long totalDeadline;
    private String phase="preflight",thread="";

    private void main(Runnable action){InstrumentationRegistry.getInstrumentation().runOnMainSync(action);}
    private void phase(String name){phase=name;Bundle status=new Bundle();status.putString("phase",name);if(!thread.isEmpty())status.putString("threadId",thread);InstrumentationRegistry.getInstrumentation().sendStatus(0,status);}
    private long deadline(){return Math.min(totalDeadline,System.currentTimeMillis()+60000);}
    private void requireTime(){if(System.currentTimeMillis()>=totalDeadline)throw new AssertionError("Public test total deadline reached");}
    private JSONObject snapshot()throws Exception{AtomicReference<JSONObject> result=new AtomicReference<>();AtomicReference<Exception> failure=new AtomicReference<>();main(()->{try{result.set(new JSONObject(connection.snapshot.toString()));}catch(Exception e){failure.set(e);}});if(failure.get()!=null)throw failure.get();return result.get();}
    private void assertUnlocked(){Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();KeyguardManager keyguard=context.getSystemService(KeyguardManager.class);PowerManager power=context.getSystemService(PowerManager.class);assertNotNull(keyguard);assertNotNull(power);assertFalse("Unlock the device locally before this test",keyguard.isKeyguardLocked());assertFalse("Device authentication is required",keyguard.isDeviceLocked());assertTrue("Display must already be interactive",power.isInteractive());}
    private void ready(long newerThan)throws Exception{long until=deadline();while(System.currentTimeMillis()<until){AtomicReference<Boolean> ready=new AtomicReference<>(false);main(()->ready.set(connection.authenticated&&connection.supports("attachmentsV1")&&connection.lastSnapshotAt>newerThan&&"ready".equals(connection.snapshot.optString("codexState"))));if(ready.get())return;Thread.sleep(100);}throw new AssertionError("Public authentication/capability readiness timed out");}
    private JSONObject request(JSONObject command,String expected)throws Exception{return request(command,expected,deadline());}
    private JSONObject request(JSONObject command,String expected,long until)throws Exception{
        requireTime();phase(command.optString("type"));String requestId=UUID.randomUUID().toString();command.put("requestId",requestId);AtomicReference<Exception> failure=new AtomicReference<>();main(()->{try{connection.command(command);}catch(Exception e){failure.set(e);}});if(failure.get()!=null)throw new AssertionError("Command submission unconfirmed; no replay");
        long end=Math.min(totalDeadline,Math.min(until,System.currentTimeMillis()+60000));
        while(System.currentTimeMillis()<end){JSONObject event=events.poll(250,TimeUnit.MILLISECONDS);if(event==null||!requestId.equals(event.optString("requestId")))continue;if("command.result".equals(event.optString("type"))&&!event.optBoolean("ok"))throw new AssertionError("Public command rejected; no replay");if(expected.equals(event.optString("type")))return event;}
        throw new AssertionError("Public command receipt timed out; no replay");
    }
    private JSONArray history(long until)throws Exception{return request(NativeConnection.obj("type","history.list","threadId",thread,"limit",20),"history.page",until).getJSONArray("items");}
    private boolean agentHas(JSONArray items,String marker){for(int i=0;i<items.length();i++){JSONObject item=items.optJSONObject(i);if(item!=null&&"agent".equals(item.optString("kind"))&&item.optString("markdown").contains(marker))return true;}return false;}
    private JSONArray awaitAnswer(String marker,String requiredContext)throws Exception{
        long until=deadline();while(System.currentTimeMillis()<until){JSONArray items=history(until);JSONObject state=snapshot();boolean idle="idle".equals(state.optString("turnStatus"))&&(state.isNull("activeTurnId")||state.optString("activeTurnId").isEmpty());if(agentHas(items,marker)&&(requiredContext==null||agentReplyHasBoth(items,marker,requiredContext))&&idle)return items;Thread.sleep(400);}throw new AssertionError("Real assistant answer or idle state missing");
    }
    private boolean agentReplyHasBoth(JSONArray items,String marker,String context){for(int i=0;i<items.length();i++){JSONObject item=items.optJSONObject(i);if(item!=null&&"agent".equals(item.optString("kind"))){String text=item.optString("markdown");if(text.contains(marker)&&text.contains(context))return true;}}return false;}
    private JSONObject uploadSmall(String name,String mime,byte[] content)throws Exception{String id=UUID.randomUUID().toString();assertEquals(0,request(NativeConnection.obj("type","attachment.begin","threadId",thread,"uploadId",id,"name",name,"mime",mime,"size",content.length,"sha256",NativeAttachmentCache.hash(content)),"attachment.status").getInt("offset"));assertEquals(content.length,request(NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",id,"offset",0,"data",Base64.encodeToString(content,Base64.NO_WRAP)),"attachment.status").getInt("offset"));return request(NativeConnection.obj("type","attachment.finish","threadId",thread,"uploadId",id),"attachment.status").getJSONObject("attachment");}
    private void downloadEquals(JSONObject metadata,byte[] expected)throws Exception{ByteArrayOutputStream received=new ByteArrayOutputStream();boolean eof=false;while(!eof){JSONObject block=request(NativeConnection.obj("type","attachment.read","threadId",thread,"attachmentId",metadata.getString("id"),"offset",received.size()),"attachment.chunk");assertEquals(received.size(),block.getInt("offset"));byte[] data=Base64.decode(block.getString("data"),Base64.DEFAULT);assertTrue(data.length<=49152);assertTrue(received.size()+data.length<=expected.length);received.write(data);eof=block.getBoolean("eof");assertTrue(eof||data.length>0);}assertArrayEquals(expected,received.toByteArray());assertEquals(metadata.getString("sha256"),NativeAttachmentCache.hash(received.toByteArray()));}

    @Test public void realPublicChatAttachmentsReconnectAndContinuation()throws Exception{
        Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("livePublic")));
        totalDeadline=System.currentTimeMillis()+285000;assertUnlocked();phase("public.preflight");
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        // No ClassRule wake/permission changes: the already-unlocked Activity alone keeps its display on.
        ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class);
        try{
            scenario.onActivity(screen->{activity=screen;assertUnlocked();screen.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);connection=NativeConnections.get(context).find("legacy");assertNotNull("Existing production binding required",connection);assertTrue(connection.paired());assertEquals(ORIGIN,connection.relay());connection.add(listener);connection.resume();});
            ready(0);JSONObject previous=snapshot();assertFalse(Arrays.asList("running","waiting").contains(previous.optString("turnStatus")));String before=previous.optString("activeThreadId");
            request(NativeConnection.obj("type","thread.new","cwd",CWD),"command.result");long createdUntil=deadline();while(System.currentTimeMillis()<createdUntil){String candidate=snapshot().optString("activeThreadId");if(!candidate.isEmpty()&&!"null".equals(candidate)&&!candidate.equals(before)){thread=candidate;break;}Thread.sleep(100);}assertFalse("New dedicated thread missing",thread.isEmpty());phase("public.thread.created");
            String nonce=UUID.randomUUID().toString().substring(0,8),first="PANEFLOW_08_PUBLIC_CHAT_"+nonce,second="PANEFLOW_08_PUBLIC_ATTACHMENTS_"+nonce,third="PANEFLOW_08_PUBLIC_CONTINUED_"+nonce;
            request(NativeConnection.obj("type","turn.send","threadId",thread,"text","这是 PaneFlow 0.8 公网真实聊天验收。不要调用工具、不要修改文件。请仅回复 "+first+"。并在后续对话中记住这个标记。"),"command.result");awaitAnswer(first,null);phase("public.first.answer.idle");
            byte[] content=new byte[70000];Arrays.fill(content,(byte)'x');byte[] header=("PANEFLOW_08_PUBLIC_ATTACHMENT\n"+nonce+"\n").getBytes(StandardCharsets.UTF_8);System.arraycopy(header,0,content,0,header.length);String upload=UUID.randomUUID().toString();JSONObject begin=NativeConnection.obj("type","attachment.begin","threadId",thread,"uploadId",upload,"name","paneflow-public-08.txt","mime","text/plain","size",content.length,"sha256",NativeAttachmentCache.hash(content));assertEquals(0,request(begin,"attachment.status").getInt("offset"));JSONObject block=NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",upload,"offset",0,"data",Base64.encodeToString(Arrays.copyOfRange(content,0,49152),Base64.NO_WRAP));assertEquals(49152,request(block,"attachment.status").getInt("offset"));
            AtomicReference<Long> oldSnapshot=new AtomicReference<>();main(()->{oldSnapshot.set(connection.lastSnapshotAt);connection.disconnect();});phase("public.disconnected.mid.upload");Thread.sleep(250);main(()->connection.resume());ready(oldSnapshot.get());assertEquals(ORIGIN,connection.relay());request(NativeConnection.obj("type","thread.open","threadId",thread),"command.result");phase("public.reauthenticated.original.binding");assertEquals(49152,request(begin,"attachment.status").getInt("offset"));assertEquals(49152,request(block,"attachment.status").getInt("offset"));assertEquals(content.length,request(NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",upload,"offset",49152,"data",Base64.encodeToString(Arrays.copyOfRange(content,49152,content.length),Base64.NO_WRAP)),"attachment.status").getInt("offset"));JSONObject textMeta=request(NativeConnection.obj("type","attachment.finish","threadId",thread,"uploadId",upload),"attachment.status").getJSONObject("attachment");
            Bitmap bitmap=Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888);bitmap.eraseColor(Color.RED);ByteArrayOutputStream png=new ByteArrayOutputStream();assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,png));bitmap.recycle();byte[] picture=png.toByteArray();JSONObject imageMeta=uploadSmall("paneflow-public-red-square.png","image/png",picture);assertEquals("image",imageMeta.getString("kind"));
            request(NativeConnection.obj("type","turn.send","threadId",thread,"text","这是同一会话的附件传输验收，有一份文本和一张红色图片。不要调用工具、不要修改或创建文件，也不用读取文本附件正文。请仅回复 "+second+"。","attachmentIds",new JSONArray().put(textMeta.getString("id")).put(imageMeta.getString("id"))),"command.result");JSONArray items=awaitAnswer(second,null);int attachedMessages=0;
            for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);JSONArray attachments=item.optJSONArray("attachments");if(attachments==null)continue;boolean hasText=false,hasImage=false;for(int j=0;j<attachments.length();j++){String id=attachments.getJSONObject(j).optString("id");hasText|=id.equals(textMeta.getString("id"));hasImage|=id.equals(imageMeta.getString("id"));}if(hasText||hasImage){assertTrue("Both attachments must belong to the same message",hasText&&hasImage);assertEquals(2,attachments.length());attachedMessages++;}}assertEquals("Attachments must be sent exactly once",1,attachedMessages);phase("public.two.attachments.in.history");downloadEquals(textMeta,content);downloadEquals(imageMeta,picture);phase("public.downloads.byte.equal");
            request(NativeConnection.obj("type","turn.send","threadId",thread,"text","继续真实会话验收。不要调用工具或修改文件。请只回复 "+third+"，随后空格加上你在第一轮回复的完整 PANEFLOW_08_PUBLIC_CHAT_ 标记，验证上下文保留。"),"command.result");awaitAnswer(third,first);assertUnlocked();phase("public.third.answer.idle");
            main(()->activity.onNewIntent(new Intent().setAction("com.codexpane.OPEN_CHAT").putExtra("computerId","legacy").putExtra("threadId",thread)));phase("public.complete");
        }catch(Throwable error){throw new AssertionError("Public live verification failed at "+phase+"; task commands were not replayed");}
        finally{main(()->{if(connection!=null)connection.remove(listener);if(activity!=null)activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);});/* Leave the ordinary chat visible; do not dispose its shared connection. */}
    }
}
