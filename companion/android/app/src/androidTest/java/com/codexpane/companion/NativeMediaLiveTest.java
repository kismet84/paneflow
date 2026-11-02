package com.codexpane.companion;

import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.Assume;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import android.util.Base64;
import static org.junit.Assert.*;

/** Explicit isolated live transport test; no Activity, lock-screen action or production binding changes. */
public class NativeMediaLiveTest {
    @org.junit.ClassRule public static NativeTestCpuRule cpu = new NativeTestCpuRule();
    private final BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
    private NativeConnection connection;
    private void main(Runnable action){InstrumentationRegistry.getInstrumentation().runOnMainSync(action);}
    private JSONObject request(JSONObject command,String type)throws Exception{
        android.os.Bundle phase=new android.os.Bundle();phase.putString("phase",command.optString("type"));InstrumentationRegistry.getInstrumentation().sendStatus(0,phase);
        AtomicReference<String> id=new AtomicReference<>();AtomicReference<Exception> failure=new AtomicReference<>();
        main(()->{try{id.set(connection.command(command));}catch(Exception e){failure.set(e);}});if(failure.get()!=null)throw failure.get();
        long deadline=System.currentTimeMillis()+45000;
        while(System.currentTimeMillis()<deadline){JSONObject event=events.poll(1,TimeUnit.SECONDS);if(event==null||!id.get().equals(event.optString("requestId")))continue;if("command.result".equals(event.optString("type"))&&!event.optBoolean("ok"))throw new AssertionError("Isolated command rejected: "+command.optString("type"));if(type.equals(event.optString("type")))return event;}
        AtomicReference<String> detail=new AtomicReference<>();main(()->detail.set(connection.diagnostics().toString()+" snapshotAt="+connection.lastSnapshotAt+" status="+connection.status));throw new AssertionError("Isolated command timed out: "+command.optString("type")+" "+detail.get());
    }
    private void ready()throws Exception{for(int i=0;i<450;i++){AtomicReference<Boolean> ok=new AtomicReference<>(false);main(()->ok.set(connection.authenticated&&connection.supports("attachmentsV1")));if(ok.get())return;Thread.sleep(100);}throw new AssertionError("Isolated media connection unavailable");}
    @Test public void encryptedPhoneUploadReconnectSendHistoryAndDownload()throws Exception{
        android.os.Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("liveMedia")));
        String profile=args.getString("computerId",""),thread=args.getString("threadId","");assertEquals("18386e4e-238a-409a-b0e8-4fef3629852e",profile);assertFalse(thread.isEmpty());
        main(()->{if(NativeConnections.get(InstrumentationRegistry.getInstrumentation().getTargetContext()).anyBackground())NativeMessagingService.ensure(InstrumentationRegistry.getInstrumentation().getTargetContext());connection=new NativeConnection(InstrumentationRegistry.getInstrumentation().getTargetContext(),profile);assertEquals("http://localhost:48433",connection.relay());connection.add(event->events.offer(event));connection.resume();});
        try{
            ready();request(NativeConnection.obj("type","thread.open","threadId",thread),"command.result");
            byte[] content=new byte[70000];Arrays.fill(content,(byte)'x');byte[] marker="PANEFLOW_08_ATTACHMENT_TEST\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);System.arraycopy(marker,0,content,0,marker.length);
            String upload=UUID.randomUUID().toString();JSONObject begin=NativeConnection.obj("type","attachment.begin","threadId",thread,"uploadId",upload,"name","paneflow-08-test.txt","mime","text/plain","size",content.length,"sha256",NativeAttachmentCache.hash(content));
            assertEquals(0,request(begin,"attachment.status").getInt("offset"));
            JSONObject chunk=NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",upload,"offset",0,"data",Base64.encodeToString(Arrays.copyOfRange(content,0,49152),Base64.NO_WRAP));
            assertEquals(49152,request(chunk,"attachment.status").getInt("offset"));
            main(()->connection.disconnect());Thread.sleep(250);main(()->connection.resume());ready();
            request(NativeConnection.obj("type","thread.open","threadId",thread),"command.result");begin.remove("requestId");assertEquals(49152,request(begin,"attachment.status").getInt("offset"));
            chunk.remove("requestId");assertEquals(49152,request(chunk,"attachment.status").getInt("offset"));
            request(NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",upload,"offset",49152,"data",Base64.encodeToString(Arrays.copyOfRange(content,49152,content.length),Base64.NO_WRAP)),"attachment.status");
            JSONObject meta=request(NativeConnection.obj("type","attachment.finish","threadId",thread,"uploadId",upload),"attachment.status").getJSONObject("attachment");
            android.graphics.Bitmap bitmap=android.graphics.Bitmap.createBitmap(32,32,android.graphics.Bitmap.Config.ARGB_8888);bitmap.eraseColor(android.graphics.Color.RED);java.io.ByteArrayOutputStream png=new java.io.ByteArrayOutputStream();bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,png);bitmap.recycle();byte[] picture=png.toByteArray();String imageUpload=UUID.randomUUID().toString();
            request(NativeConnection.obj("type","attachment.begin","threadId",thread,"uploadId",imageUpload,"name","red-square.png","mime","image/png","size",picture.length,"sha256",NativeAttachmentCache.hash(picture)),"attachment.status");
            request(NativeConnection.obj("type","attachment.chunk","threadId",thread,"uploadId",imageUpload,"offset",0,"data",Base64.encodeToString(picture,Base64.NO_WRAP)),"attachment.status");
            JSONObject imageMeta=request(NativeConnection.obj("type","attachment.finish","threadId",thread,"uploadId",imageUpload),"attachment.status").getJSONObject("attachment");assertEquals("image",imageMeta.getString("kind"));
            request(NativeConnection.obj("type","turn.send","threadId",thread,"text","这是附件传输验收。不要调用工具或修改文件，仅回复 PANEFLOW_08_ATTACHMENT_ACCEPTED。","attachmentIds",new JSONArray().put(meta.getString("id")).put(imageMeta.getString("id"))),"command.result");
            boolean found=false;for(int attempt=0;attempt<25;attempt++){JSONObject page=request(NativeConnection.obj("type","history.list","threadId",thread,"limit",20),"history.page");JSONArray items=page.getJSONArray("items");for(int i=0;i<items.length();i++){JSONArray attachments=items.getJSONObject(i).optJSONArray("attachments");if(attachments!=null)for(int j=0;j<attachments.length();j++)if(meta.getString("id").equals(attachments.getJSONObject(j).optString("id"))){assertEquals(2,attachments.length());found=true;}}if(found)break;Thread.sleep(500);}assertTrue("Attachment missing or duplicated in real history",found);
            java.io.ByteArrayOutputStream received=new java.io.ByteArrayOutputStream();boolean eof=false;while(!eof){JSONObject block=request(NativeConnection.obj("type","attachment.read","threadId",thread,"attachmentId",meta.getString("id"),"offset",received.size()),"attachment.chunk");received.write(Base64.decode(block.getString("data"),Base64.DEFAULT));eof=block.getBoolean("eof");}assertArrayEquals(content,received.toByteArray());
            boolean answered=false;for(int attempt=0;attempt<90;attempt++){JSONObject page=request(NativeConnection.obj("type","history.list","threadId",thread,"limit",20),"history.page");JSONArray items=page.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);if("agent".equals(item.optString("kind"))&&item.optString("markdown").contains("PANEFLOW_08_ATTACHMENT_ACCEPTED"))answered=true;}if(answered)break;Thread.sleep(500);}assertTrue("Real assistant response unavailable",answered);
        }finally{main(()->connection.dispose());}
    }
}
