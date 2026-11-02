package com.codexpane.companion;

import android.content.*;
import android.app.Dialog;
import android.widget.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** 0.6 fixture checks are isolated from real computer profiles, keys and queues. */
@RunWith(AndroidJUnit4.class)
public class NativeTaskConsoleTest {
    private static final class TestContext extends ContextWrapper {
        final String prefix="console06-"+UUID.randomUUID()+"-";final File directory;final Set<String> prefs=new HashSet<>();
        TestContext(){super(InstrumentationRegistry.getInstrumentation().getTargetContext());directory=new File(super.getNoBackupFilesDir(),prefix);assertTrue(directory.mkdirs());}
        @Override public SharedPreferences getSharedPreferences(String name,int mode){prefs.add(prefix+name);return super.getSharedPreferences(prefix+name,mode);}
        @Override public File getNoBackupFilesDir(){return directory;}
        void cleanup(){for(String name:prefs)super.deleteSharedPreferences(name);File[] files=directory.listFiles();if(files!=null)for(File file:files)assertTrue(file.delete());assertTrue(directory.delete());}
    }
    private static Object field(Object target,String name)throws Exception {Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(target);}
    private static void set(Object target,String name,Object value)throws Exception {Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);f.set(target,value);}
    private static JSONObject thread(String id,String cwd,String goal,String runtime){return NativeConnection.obj("id",id,"title","Task "+id,"cwd",cwd,"goalStatus",goal,"status",runtime,"updatedAt",1000);}
    private static JSONObject approval(String thread,int version){return NativeConnection.obj("threadId",thread,"cwd","D:\\fixture","updatedAt",1000,"approval",NativeConnection.obj("id","same-approval-id","kind","approval","title","Fixture operation","summary","Read the isolated fixture","version",version));}
    @Test public void aggregationSeparatesComputersProjectsAndAllThreeStates()throws Exception {
        TestContext context=new TestContext();NativeConnection a=new NativeConnection(context,"a"),b=new NativeConnection(context,"b");try{
            a.snapshot=NativeConnection.obj("threads",new JSONArray().put(thread("same-thread","D:\\A","active","idle")),"queue",NativeConnection.obj("tasks",new JSONArray().put(NativeConnection.obj("id","task-a","threadId","same-thread","title","Queued A","cwd","D:\\A","queueState","pending","updatedAt",2000))));
            b.snapshot=NativeConnection.obj("threads",new JSONArray().put(thread("same-thread","D:\\B","complete","idle")),"queue",NativeConnection.obj("tasks",new JSONArray().put(NativeConnection.obj("id","task-b","title","Unknown B","cwd","D:\\B","queueState","unknown","updatedAt",3000))));
            List<NativeTaskCatalog.Row> rows=NativeTaskCatalog.rows(Arrays.asList(a,b));assertEquals(3,rows.size());assertEquals(1,NativeTaskCatalog.filter(rows,"a","","all","").size());assertEquals(2,NativeTaskCatalog.filter(rows,"","D:\\B","all","").size());assertEquals(1,NativeTaskCatalog.filter(rows,"","","pending","").size());assertEquals(1,NativeTaskCatalog.filter(rows,"","","unknown","").size());assertEquals(1,NativeTaskCatalog.filter(rows,"","","complete","").size());
            NativeTaskCatalog.Row queued=NativeTaskCatalog.filter(rows,"a","","all","").get(0);assertEquals("active",queued.goal);assertEquals("idle",queued.runtime);assertEquals("pending",queued.queue);assertEquals("task-a",queued.taskId);assertEquals("same-thread",queued.threadId);assertFalse(rows.get(0).identity().equals(rows.get(1).identity()));
        }finally{a.dispose();b.dispose();context.cleanup();}
    }
    @Test public void mixedSecondAndMillisecondTimestampsSortByActualTime()throws Exception {
        TestContext context=new TestContext();NativeConnection c=new NativeConnection(context,"time");try{JSONObject newer=thread("newer","D:\\new","active","idle"),older=NativeConnection.obj("id","older-queue","title","Older queue","cwd","D:\\old","queueState","completed","updatedAt",1700000000000L);newer.put("updatedAt",1800000000L);c.snapshot=NativeConnection.obj("threads",new JSONArray().put(newer),"queue",NativeConnection.obj("tasks",new JSONArray().put(older)));List<NativeTaskCatalog.Row> rows=NativeTaskCatalog.rows(Arrays.asList(c));assertEquals("newer",rows.get(0).threadId);assertEquals(1800000000000L,rows.get(0).updatedAt);assertEquals(1700000000000L,rows.get(1).updatedAt);}finally{c.dispose();context.cleanup();}
    }
    @Test public void approvalsAreScopedToComputerThreadAndExactVersion()throws Exception {
        TestContext context=new TestContext();NativeConnection a=new NativeConnection(context,"a"),b=new NativeConnection(context,"b");try{
            JSONObject expected=approval("thread-a",1);a.snapshot=NativeConnection.obj("approvals",new JSONArray().put(expected));b.snapshot=NativeConnection.obj("approvals",new JSONArray().put(approval("thread-b",1)));
            assertTrue(NativeTaskCatalog.approvalCurrent(a,expected));assertFalse(NativeTaskCatalog.approvalCurrent(b,expected));a.snapshot=NativeConnection.obj("approvals",new JSONArray().put(approval("thread-a",2)));assertFalse(NativeTaskCatalog.approvalCurrent(a,expected));a.snapshot=NativeConnection.obj("approvals",new JSONArray());assertFalse(NativeTaskCatalog.approvalCurrent(a,expected));
        }finally{a.dispose();b.dispose();context.cleanup();}
    }
    @Test public void templatesPersistInOwnComputerAndDiscardPermissionFields()throws Exception {
        TestContext context=new TestContext();try{NativeLocalStore a=new NativeLocalStore(context,"a"),b=new NativeLocalStore(context,"b");JSONObject value=NativeConnection.obj("name","Template A","cwd","D:\\A","text","fixture prompt","model","fixture-model","effort","high","approvalPolicy","never","sandbox","danger-full-access","permanentApproval",true);String id=NativeTaskTemplates.save(a,value);JSONObject saved=NativeTaskTemplates.list(new NativeLocalStore(context,"a")).getJSONObject(0);assertEquals("fixture prompt",saved.getString("text"));assertFalse(saved.has("approvalPolicy"));assertFalse(saved.has("sandbox"));assertFalse(saved.has("permanentApproval"));assertEquals(0,NativeTaskTemplates.list(b).length());value.put("id",id);value.put("name","Template B");NativeTaskTemplates.save(b,value);NativeTaskTemplates.remove(a,id);assertEquals(0,NativeTaskTemplates.list(a).length());assertEquals("Template B",NativeTaskTemplates.list(b).getJSONObject(0).getString("name"));}finally{context.cleanup();}
    }
    @Test public void detailReplyCannotOverwriteAnewerRequest()throws Exception {
        TestContext context=new TestContext();NativeConnection c=new NativeConnection(context,"detail");try{c.taskDetailRequest="new-request";Method apply=NativeConnection.class.getDeclaredMethod("applyEvent",JSONObject.class);apply.setAccessible(true);apply.invoke(c,NativeConnection.obj("type","task.detail","requestId","old-request","detail",NativeConnection.obj("taskId","old")));assertEquals("",c.taskDetail.optString("taskId"));apply.invoke(c,NativeConnection.obj("type","task.detail","requestId","new-request","detail",NativeConnection.obj("taskId","new")));assertEquals("new",c.taskDetail.getString("taskId"));assertEquals("",c.taskDetailRequest);}finally{c.dispose();context.cleanup();}
    }
    @Test public void visibleApprovalDialogClosesWhenAnotherDeviceResolvesIt()throws Exception {
        TestContext context=new TestContext();Constructor<NativeConnections> ctor=NativeConnections.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);NativeConnections manager=ctor.newInstance(context);NativeConnection c=manager.active();JSONObject expected=approval("thread-fixture",1);c.snapshot=NativeConnection.obj("threads",new JSONArray(),"items",new JSONArray(),"capabilities",new JSONArray().put("approvalCenter"),"approvals",new JSONArray().put(expected));c.authenticated=true;
        Field singleton=NativeConnections.class.getDeclaredField("instance");singleton.setAccessible(true);Object original=singleton.get(null);singleton.set(null,manager);
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){scenario.onActivity(activity->{try{NativeTaskConsole console=(NativeTaskConsole)field(activity,"taskConsole");Method show=NativeTaskConsole.class.getDeclaredMethod("approvalSheet",NativeConnection.class,JSONObject.class);show.setAccessible(true);show.invoke(console,c,expected);Dialog dialog=(Dialog)field(console,"liveApprovalDialog");assertTrue(dialog.isShowing());NativeConnection.put(c.snapshot,"approvals",new JSONArray());activity.changed(NativeConnection.obj("type","snapshot","computerId",c.computerId));assertFalse("Stale approval dialog remained actionable",dialog.isShowing());assertEquals(0,c.requests(null).length());}catch(Exception e){throw new AssertionError(e);}});}finally{singleton.set(null,original);for(NativeConnection owned:manager.all())owned.dispose();context.cleanup();}
    }
}
