package com.codexpane.companion;
import android.app.KeyguardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.lang.reflect.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Read-only route walkthrough: no pairing, sending, approval or device-lock actions. */
public class NativeVisualCleanupTest {
 private static ActivityScenario<NativeChatActivity> screen;
 private String text(View v){StringBuilder s=new StringBuilder();if(v instanceof TextView)s.append(((TextView)v).getText()).append("\n");if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++)s.append(text(((ViewGroup)v).getChildAt(i)));return s.toString();}
 private void navigate(NativeChatActivity a,String route)throws Exception {Method m=NativeChatActivity.class.getDeclaredMethod("navigate",String.class);m.setAccessible(true);m.invoke(a,route);}
 @Test public void walkthrough()throws Exception {
  Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("visualCleanup")));
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
  screen=ActivityScenario.launch(NativeChatActivity.class);NativeConnection c=NativeConnections.get(context).find("legacy");assertNotNull(c);
  long deadline=System.currentTimeMillis()+60000;while(!c.authenticated&&System.currentTimeMillis()<deadline)Thread.sleep(100);assertTrue(c.authenticated);
  File dir=new File(context.getExternalFilesDir(null),"ui-cleanup");assertTrue(dir.isDirectory()||dir.mkdirs());
  for(String route:new String[]{"tasks","sessions","settings","usage","connection","computers","notifications","diagnostics","new","queue","queueNew","approvals","templates","updates","pair","chat"}){
   screen.onActivity(a->{try{navigate(a,route);}catch(Exception e){throw new AssertionError(e);}});
   if("usage".equals(route)){deadline=System.currentTimeMillis()+20000;while(!c.usageRequest.isEmpty()&&System.currentTimeMillis()<deadline)Thread.sleep(100);}
   if("sessions".equals(route)){deadline=System.currentTimeMillis()+20000;while(!c.historyRequest.isEmpty()&&System.currentTimeMillis()<deadline)Thread.sleep(100);assertTrue("History request did not finish",c.historyRequest.isEmpty());}
   Thread.sleep(400);
   screen.onActivity(a->{String shown=text(a.getWindow().getDecorView());assertFalse(shown.contains("Token 使用情况"));assertFalse(shown.contains("不同电脑可能共用同一账户"));if("usage".equals(route)){assertTrue(shown.contains("刷新用量")||shown.contains("正在读取"));assertFalse(shown.contains("累计 Token"));}if("settings".equals(route))assertTrue(shown.contains("用量管理"));});
   Bitmap image=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();assertNotNull(image);try(FileOutputStream out=new FileOutputStream(new File(dir,route+".png"))){assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,out));}image.recycle();
   Bundle status=new Bundle();status.putString("stream","VISUAL_ROUTE_OK "+route+"\n");InstrumentationRegistry.getInstrumentation().sendStatus(0,status);
  }
  screen.onActivity(a->{try{navigate(a,"settings");}catch(Exception e){throw new AssertionError(e);}});assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
 }
}
