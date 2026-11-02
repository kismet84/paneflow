package com.codexpane.companion;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

@RunWith(AndroidJUnit4.class)
public class NativeAttachmentTest {
    @org.junit.ClassRule public static NativeTestCpuRule cpu = new NativeTestCpuRule();
    private static void event(NativeConnection connection,JSONObject event)throws Exception{java.lang.reflect.Method method=NativeConnection.class.getDeclaredMethod("applyEvent",JSONObject.class);method.setAccessible(true);method.invoke(connection,event);}
    private static JSONObject item(String id,boolean available){return NativeConnection.obj("id","message-1","kind","user","text","","attachments",new org.json.JSONArray().put(NativeConnection.obj("id",id,"available",available)));}
    private static JSONObject snapshot(String thread,JSONObject item){return NativeConnection.obj("type","snapshot","snapshot",NativeConnection.obj("activeThreadId",thread,"items",new org.json.JSONArray().put(item),"threads",new org.json.JSONArray()));}
    @Test public void lostDeleteAckRecoveredFromSnapshotSurvivesRestartAndStaleTrue()throws Exception{
        android.content.Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String computer="media-test-"+UUID.randomUUID(),attachment=UUID.randomUUID().toString();NativeConnection c=new NativeConnection(context,computer);
        try{event(c,snapshot("thread-a",item(attachment,false)));assertEquals("true",c.local.text("attachmentDeleted","thread-a:"+attachment));c.dispose();c=new NativeConnection(context,computer);assertEquals("true",c.local.text("attachmentDeleted","thread-a:"+attachment));event(c,snapshot("thread-a",item(attachment,true)));assertEquals("true",c.local.text("attachmentDeleted","thread-a:"+attachment));}finally{c.dispose();c.local.clear();}
    }
    @Test public void historyAndOtherDeviceUpsertPersistDeletionWithoutCrossComputerLeak()throws Exception{
        android.content.Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();String attachment=UUID.randomUUID().toString();NativeConnection c=new NativeConnection(context,"media-test-"+UUID.randomUUID()),other=new NativeConnection(context,"media-test-"+UUID.randomUUID());
        try{
            event(c,NativeConnection.obj("type","history.page","requestId",UUID.randomUUID().toString(),"threadId","older-thread","items",new org.json.JSONArray().put(item(attachment,false)),"nextCursor",JSONObject.NULL));
            assertEquals("true",c.local.text("attachmentDeleted","older-thread:"+attachment));
            event(c,NativeConnection.obj("type","item.upsert","threadId","current-thread","item",item(attachment,false)));
            assertEquals("true",c.local.text("attachmentDeleted","current-thread:"+attachment));
            event(c,NativeConnection.obj("type","item.upsert","threadId","current-thread","item",item(attachment,true)));
            assertEquals("true",c.local.text("attachmentDeleted","current-thread:"+attachment));assertEquals("",other.local.text("attachmentDeleted","current-thread:"+attachment));assertEquals("",c.local.text("attachmentDeleted","unrelated-thread:"+attachment));
        }finally{c.dispose();c.local.clear();other.dispose();other.local.clear();}
    }
    @Test public void restoreRequiresKnownFailureOrExplicitNotExecuted(){assertFalse(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","unknown")));assertFalse(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","waiting")));assertFalse(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","completed")));assertTrue(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","failed")));assertTrue(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","failed","manualResolution","notExecuted")));assertFalse(NativeAttachments.canRestoreRequest(NativeConnection.obj("status","failed","manualResolution","completed")));}
    @Test public void windowsNamesPreserveExtensionWithoutUnsafeCharacters(){assertEquals("_CON.txt",NativeAttachments.safeName("CON.txt"));assertEquals("report___2026.txt",NativeAttachments.safeName("report:*?2026.txt"));assertEquals("照片",NativeAttachments.safeName("照片. "));assertEquals("_A_B",NativeAttachments.safeName("\nA/B"));}
    @Test public void encryptedCacheSurvivesNewInstanceAndRejectsTampering()throws Exception{
        android.content.Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();String id=UUID.randomUUID().toString();NativeAttachmentCache cache=new NativeAttachmentCache(c);byte[] plain="attachment-private-test-content".getBytes(StandardCharsets.UTF_8);File file=new File(c.getNoBackupFilesDir(),"attachment-cache/"+id+".enc");
        try{cache.save(id,plain);assertArrayEquals(plain,new NativeAttachmentCache(c).read(id));byte[] stored=java.nio.file.Files.readAllBytes(file.toPath());assertFalse(new String(stored,StandardCharsets.UTF_8).contains("attachment-private-test-content"));stored[stored.length-1]^=1;java.nio.file.Files.write(file.toPath(),stored);try{cache.read(id);fail("Tampering accepted");}catch(javax.crypto.AEADBadTagException expected){}}finally{cache.remove(id);}
    }
    @Test public void cacheRejectsPathTraversal()throws Exception{NativeAttachmentCache cache=new NativeAttachmentCache(InstrumentationRegistry.getInstrumentation().getTargetContext());try{cache.read("../../outside");fail("Traversal accepted");}catch(IllegalArgumentException expected){}}
    @Test public void boundedImportRejectsEmptyAndOversize()throws Exception{try{NativeAttachmentCache.bounded(new ByteArrayInputStream(new byte[0]));fail("Empty accepted");}catch(IOException expected){}InputStream generated=new InputStream(){int remaining=NativeAttachmentCache.MAX_BYTES+1;public int read(){return remaining-->0?1:-1;}};try{NativeAttachmentCache.bounded(generated);fail("Oversize accepted");}catch(IOException expected){}}
    @Test public void metadataRejectsOversizeAndUntrustedIds()throws Exception{JSONObject a=NativeConnection.obj("id",UUID.randomUUID().toString(),"size",12,"sha256",new String(new char[64]).replace('\0','0'));NativeAttachments.validate(a);a.put("size",NativeAttachmentCache.MAX_BYTES+1);try{NativeAttachments.validate(a);fail("Oversize accepted");}catch(IOException expected){}a.put("size",12);a.put("id","../../arbitrary");try{NativeAttachments.validate(a);fail("Bad ID accepted");}catch(IllegalArgumentException expected){}}
    @Test public void attachmentTransportIsNotTaskReceipt()throws Exception{android.content.Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();NativeConnection connection=new NativeConnection(c,"media-test-"+UUID.randomUUID());try{java.lang.reflect.Method tracked=NativeConnection.class.getDeclaredMethod("tracked",String.class);tracked.setAccessible(true);assertEquals(false,tracked.invoke(connection,"attachment.chunk"));assertEquals(false,tracked.invoke(connection,"attachment.cancel"));assertEquals(true,tracked.invoke(connection,"turn.send"));}finally{connection.dispose();connection.local.clear();}}
}
