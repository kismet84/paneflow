package com.codexpane.companion;

import android.content.Context;
import android.os.PowerManager;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.rules.ExternalResource;

/** Keep only the CPU awake during explicit instrumentation; never wake or unlock the display. */
public final class NativeTestCpuRule extends ExternalResource {
    private PowerManager.WakeLock cpu;
    @Override protected void before(){
        if(android.os.Build.VERSION.SDK_INT>=29){
            InstrumentationRegistry.getInstrumentation().getUiAutomation().adoptShellPermissionIdentity(android.Manifest.permission.WAKE_LOCK);
            PowerManager manager=(PowerManager)InstrumentationRegistry.getInstrumentation().getTargetContext().getSystemService(Context.POWER_SERVICE);
            cpu=manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"PaneFlow:Instrumentation");cpu.acquire(240000);
        }
    }
    @Override protected void after(){if(cpu!=null&&cpu.isHeld())cpu.release();if(android.os.Build.VERSION.SDK_INT>=29)InstrumentationRegistry.getInstrumentation().getUiAutomation().dropShellPermissionIdentity();}
}
