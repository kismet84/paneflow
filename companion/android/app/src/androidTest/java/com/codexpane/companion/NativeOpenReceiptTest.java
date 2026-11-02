package com.codexpane.companion;

import android.app.Dialog;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Collection;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeOpenReceiptTest {
    private Object get(Object o,String key) throws Exception {Field f=o.getClass().getDeclaredField(key);f.setAccessible(true);return f.get(o);}
    private void set(Object o,String key,Object value) throws Exception {Field f=o.getClass().getDeclaredField(key);f.setAccessible(true);f.set(o,value);}
    @Test public void backgroundAndStaleReceiptsDoNotInterruptCurrentSelection() {
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)) {
            scenario.onActivity(a->{try{
                set(a,"pendingOpenRequest","new-open");set(a,"pendingNavigate","new-target");
                int before=((Collection<?>)get(a,"dialogs")).size();
                a.changed(NativeConnection.obj("type","command.result","requestId","old-restore","ok",false,"backgroundSelectionRestore",true,"message","thread old already has an active writer"));
                assertEquals(before,((Collection<?>)get(a,"dialogs")).size());
                assertEquals("new-open",get(a,"pendingOpenRequest"));
                a.changed(NativeConnection.obj("type","command.result","requestId","old-open","commandType","thread.open","ok",false,"message","old failure"));
                assertEquals(before,((Collection<?>)get(a,"dialogs")).size());
                assertEquals("new-target",get(a,"pendingNavigate"));
                String route=(String)get(a,"route");
                a.changed(NativeConnection.obj("type","command.result","requestId","new-open","commandType","thread.open","ok",false,"message","thread target already has an active writer"));
                assertEquals(route,get(a,"route"));assertEquals("",get(a,"pendingOpenRequest"));assertEquals("",get(a,"pendingNavigate"));
                for(Object d:new java.util.ArrayList<>((Collection<?>)get(a,"dialogs")))((Dialog)d).dismiss();
            }catch(Exception e){throw new AssertionError(e);}});
        }
    }
}
