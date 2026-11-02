package com.codexpane.companion;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.view.WindowManager;
import android.widget.ScrollView;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Uses the paired real desktop, without changing goals or sending chat messages. */
@RunWith(AndroidJUnit4.class)
public class PaneFlowPaginationTest {
    private void await(java.util.function.BooleanSupplier condition) throws Exception {
        for(int i=0;i<300;i++){
            AtomicBoolean yes=new AtomicBoolean();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->yes.set(condition.getAsBoolean()));
            if(yes.get())return;Thread.sleep(100);
        }
        fail("Timed out waiting for the real paginated history");
    }
    @Test public void firstFiveThenTenOnScroll() throws Exception {
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){
            NativeConnection connection=NativeConnection.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
            await(()->connection.authenticated);
            scenario.onActivity(a->{try{
                a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                Method navigate=NativeChatActivity.class.getDeclaredMethod("navigate",String.class);navigate.setAccessible(true);navigate.invoke(a,"sessions");
            }catch(Exception e){throw new AssertionError(e);}});
            await(()->connection.historyLoaded&&connection.historyRequest.isEmpty());
            assertEquals(5,connection.historyThreads.length());
            assertFalse(connection.historyCursor.isEmpty());
            // The protocol receipt precedes the Activity's throttled render and layout.
            java.util.concurrent.atomic.AtomicReference<ScrollView> rendered=new java.util.concurrent.atomic.AtomicReference<>();
            scenario.onActivity(a->{try{Field f=NativeChatActivity.class.getDeclaredField("scroll");f.setAccessible(true);rendered.set((ScrollView)f.get(a));}catch(Exception e){throw new AssertionError(e);}});
            await(()->rendered.get().getChildAt(0).getHeight()>rendered.get().getHeight());
            scenario.onActivity(a->{try{
                Field field=NativeChatActivity.class.getDeclaredField("scroll");field.setAccessible(true);ScrollView scroll=(ScrollView)field.get(a);
                scroll.smoothScrollTo(0,scroll.getChildAt(0).getHeight());
            }catch(Exception e){throw new AssertionError(e);}});
            await(()->connection.historyThreads.length()>=15&&connection.historyRequest.isEmpty());
            assertEquals(15,connection.historyThreads.length());
            HashSet<String> ids=new HashSet<>();
            for(int i=0;i<connection.historyThreads.length();i++)assertTrue(ids.add(connection.historyThreads.getJSONObject(i).getString("id")));
            // Query invalidation drops old cursor immediately, before the next network round trip.
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->connection.invalidateHistory("new query"));
            assertEquals("",connection.historyCursor);assertEquals(0,connection.historyThreads.length());assertFalse(connection.historyLoaded);
        }
    }
}
