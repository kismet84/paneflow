package com.codexpane.companion;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
/** Explicit legacy fallback, not used for native conversation rendering. */
public class ChromeBackupActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) { registerPlugin(ChromeSessionPlugin.class); super.onCreate(savedInstanceState); }
}
