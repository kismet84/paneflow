package com.codexpane.companion;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.os.Bundle;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real bound device. Parent interrupts only the dedicated desktop/relay/tunnel. Never locks screen. */
@RunWith(AndroidJUnit4.class)
public class NativeReconnectTest {
    private void await(java.util.function.BooleanSupplier condition, int seconds) throws Exception {
        for(int i=0;i<seconds*10;i++){
            final boolean[] ok={false};
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->ok[0]=condition.getAsBoolean());
            if(ok[0])return;Thread.sleep(100);
        }
        throw new AssertionError("Reconnect condition timed out");
    }
    @Test public void retainsBindingAcrossOutage() throws Exception {
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){
            final NativeConnection[] ref={null};
            scenario.onActivity(a->{ref[0]=NativeConnection.get(a);a.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);});
            NativeConnection c=ref[0];await(()->c.authenticated,60);
            android.content.Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
            String before=context.getSharedPreferences("native-device",0).getString("binding","");
            assertFalse(before.isEmpty());String expectedRelay=InstrumentationRegistry.getArguments().getString("relayOrigin", "");
            assertTrue("Pass -e relayOrigin https://your-host",expectedRelay.startsWith("https://"));assertEquals(expectedRelay,c.relay());
            Bundle status=new Bundle();status.putString("stream","READY_FOR_RESTART\n");InstrumentationRegistry.getInstrumentation().sendStatus(2,status);
            await(()->!c.authenticated,90);await(()->c.authenticated,150);
            assertFalse(c.pairingActive());
            assertEquals(before,context.getSharedPreferences("native-device",0).getString("binding",""));
            Bundle done=new Bundle();done.putString("stream","RECONNECTED_WITH_SAME_BINDING\n");InstrumentationRegistry.getInstrumentation().sendStatus(2,done);
        }
    }
}
