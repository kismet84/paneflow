package com.codexpane.companion;

import android.content.Context;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeReadOnlyTest {
    private Object get(Object o,String key)throws Exception{Field f=o.getClass().getDeclaredField(key);f.setAccessible(true);return f.get(o);}
    private void set(Object o,String key,Object value)throws Exception{Field f=o.getClass().getDeclaredField(key);f.setAccessible(true);f.set(o,value);}
    private void call(Object o,String key)throws Exception{Method m=o.getClass().getDeclaredMethod(key);m.setAccessible(true);m.invoke(o);}
    @Test public void readonlyDeniesWritesButAllowsReadingAndOtherThreads(){
        JSONObject snapshot=NativeConnection.obj("activeThreadId","owned","readOnly",true);
        for(String type:new String[]{"turn.send","turn.interrupt","approval.resolve","approval.decide","thread.configure","thread.fork","queue.stop","attachment.begin","attachment.chunk","attachment.finish","attachment.cancel","attachment.delete"}){
            assertTrue(type,NativeConnection.isReadOnlyWrite(snapshot,NativeConnection.obj("type",type,"threadId","owned")));
            assertFalse(type,NativeConnection.isReadOnlyWrite(snapshot,NativeConnection.obj("type",type,"threadId","other")));
        }
        for(String type:new String[]{"thread.open","snapshot.get","history.list","thread.list","attachment.read","attachment.status","request.status","task.detail"})assertFalse(type,NativeConnection.isReadOnlyWrite(snapshot,NativeConnection.obj("type",type,"threadId","owned")));
        NativeConnection.put(snapshot,"readOnly",false);
        assertFalse(NativeConnection.isReadOnlyWrite(snapshot,NativeConnection.obj("type","turn.send","threadId","owned")));
    }
    @Test public void readonlyPlaceholderNeverOverwritesPersistedDraftAndUnlockRestoresIt(){
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        NativeConnection isolated=new NativeConnection(context,"readonly-test-"+UUID.randomUUID());
        isolated.authenticated=true;
        isolated.snapshot=NativeConnection.obj("activeThreadId","test-thread","activeThreadTitle","Read-only regression","turnStatus","idle","threads",new JSONArray(),"items",new JSONArray(),"deviceOnline",true,"readOnly",true);
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){
            scenario.onActivity(a->{NativeConnection previous=null;Map<String,String> previousDrafts=null;try{
                previous=(NativeConnection)get(a,"connection");Map<String,String> drafts=(Map<String,String>)get(a,"drafts");previousDrafts=new HashMap<>(drafts);
                set(a,"connection",isolated);drafts.clear();drafts.put("test-thread","保留原草稿");set(a,"route","chat");set(a,"displayedThread","");call(a,"build");
                EditText composer=(EditText)get(a,"composer");assertFalse(composer.isEnabled());assertEquals("只读 · 电脑正在使用",composer.getHint().toString());assertEquals("",composer.getText().toString());
                assertFalse(((View)get(a,"send")).isEnabled());assertFalse(((View)get(a,"mic")).isEnabled());assertFalse(((View)get(a,"addAttachment")).isEnabled());assertFalse(((TextView)get(a,"modelLabel")).isEnabled());
                call(a,"saveInputs");assertEquals("保留原草稿",isolated.local.section("drafts").optString("test-thread"));
                try{isolated.command(NativeConnection.obj("type","turn.send","threadId","test-thread","text","must not send"));fail("read-only write was accepted");}catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("只读"));}
                NativeConnection.put(isolated.snapshot,"readOnlyUpdatedAt",System.currentTimeMillis());call(a,"renderChat");assertSame(composer,get(a,"composer"));assertEquals("保留原草稿",drafts.get("test-thread"));
                NativeConnection.put(isolated.snapshot,"readOnly",false);call(a,"renderChat");assertTrue(composer.isEnabled());assertEquals("保留原草稿",composer.getText().toString());
            }catch(Exception e){throw new AssertionError(e);}finally{try{
                set(a,"composer",null);set(a,"displayedThread","");set(a,"connection",previous);Map<String,String> drafts=(Map<String,String>)get(a,"drafts");drafts.clear();if(previousDrafts!=null)drafts.putAll(previousDrafts);set(a,"route","sessions");call(a,"build");
            }catch(Exception e){throw new AssertionError(e);}}});
        }
    }
}
