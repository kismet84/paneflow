package com.codexpane.companion;

import android.os.Bundle;
import android.widget.EditText;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.lang.reflect.Field;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Regression for pending A + newly typed B. Does not send a remote command. */
@RunWith(AndroidJUnit4.class)
public class NativeDraftLifecycleTest {
    private Object field(Object target, String name) throws Exception {
        Field f=NativeChatActivity.class.getDeclaredField(name);f.setAccessible(true);return f.get(target);
    }
    @SuppressWarnings("unchecked")
    @Test public void preservesPendingAndNewDraftSeparately() {
        final String[] original={null,null};
        try (ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)) {
            scenario.onActivity(a -> {
                try {
                    original[0]=((Map<String,String>)field(a,"drafts")).get("ui-draft-regression");original[1]=((Map<String,String>)field(a,"unconfirmed")).get("ui-draft-regression");
                    Field id=NativeChatActivity.class.getDeclaredField("displayedThread");id.setAccessible(true);id.set(a,"ui-draft-regression");
                    EditText composer=new EditText(a);composer.setText("new draft B");
                    Field input=NativeChatActivity.class.getDeclaredField("composer");input.setAccessible(true);input.set(a,composer);
                    ((Map<String,String>)field(a,"pendingText")).put("pending-test","sent A");
                    ((Map<String,String>)field(a,"pendingThreads")).put("pending-test","ui-draft-regression");
                    Bundle saved=new Bundle();a.onSaveInstanceState(saved);
                    assertEquals("new draft B",saved.getBundle("drafts").getString("ui-draft-regression"));
                    assertEquals("sent A",saved.getBundle("unconfirmed").getString("ui-draft-regression"));
                } catch(Exception e){throw new AssertionError(e);}
            });
            scenario.recreate();
            scenario.onActivity(a -> {
                try {
                    assertEquals("new draft B",((Map<String,String>)field(a,"drafts")).get("ui-draft-regression"));
                    assertEquals("sent A",((Map<String,String>)field(a,"unconfirmed")).get("ui-draft-regression"));
                    assertTrue(((Map<?,?>)field(a,"pendingText")).isEmpty());
                    Map<String,String> drafts=(Map<String,String>)field(a,"drafts"),uncertain=(Map<String,String>)field(a,"unconfirmed");
                    if(original[0]==null)drafts.remove("ui-draft-regression");else drafts.put("ui-draft-regression",original[0]);
                    if(original[1]==null)uncertain.remove("ui-draft-regression");else uncertain.put("ui-draft-regression",original[1]);
                    NativeConnection connection=(NativeConnection)field(a,"connection");connection.local.save("drafts",new org.json.JSONObject(drafts));connection.local.save("unconfirmed",new org.json.JSONObject(uncertain));
                    Field displayed=NativeChatActivity.class.getDeclaredField("displayedThread");displayed.setAccessible(true);displayed.set(a,"");
                } catch(Exception e){throw new AssertionError(e);}
            });
        }
    }
}
