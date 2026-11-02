package com.codexpane.companion;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable open=()->{if(!isFinishing()){startActivity(new Intent(this, NativeChatActivity.class));finish();}};
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PaneUi ui=new PaneUi(this);
        LinearLayout content=ui.column();content.setGravity(Gravity.CENTER);content.setBackgroundColor(PaneUi.BG);ui.pad(content,24,24);
        content.addView(ui.icon("pane",PaneUi.BLUE),new LinearLayout.LayoutParams(ui.dp(64),ui.dp(64)));
        ui.gap(content,24);TextView brand=ui.heading("PaneFlow",36);brand.setGravity(Gravity.CENTER);content.addView(brand);
        ui.gap(content,14);TextView tagline=ui.text("任务随行，随时继续。",17,PaneUi.MUTED);tagline.setGravity(Gravity.CENTER);content.addView(tagline);
        setContentView(content);
    }
    @Override protected void onResume(){super.onResume();handler.postDelayed(open,850);}
    @Override protected void onPause(){handler.removeCallbacks(open);super.onPause();}
    @Override protected void onDestroy(){handler.removeCallbacks(open);super.onDestroy();}
}
