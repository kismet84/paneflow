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
        try (ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)) {
            scenario.onActivity(a -> {
                try {
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
                } catch(Exception e){throw new AssertionError(e);}
            });
        }
    }
}
