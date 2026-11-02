package com.codexpane.companion;
import android.app.KeyguardManager;
import android.content.Context;
import android.graphics.*;
import android.view.View;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.UUID;
import static org.junit.Assert.*;
public class NativeComputerNavigationTest {
 private static Object get(Object o,String name)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
 private static void set(Object o,String name,Object v)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);f.set(o,v);}
 private static void invoke(Object o,String name,Class<?>[] types,Object...args)throws Exception{Method m=o.getClass().getDeclaredMethod(name,types);m.setAccessible(true);m.invoke(o,args);}
 private static void nav(NativeChatActivity a,String route)throws Exception{invoke(a,"navigate",new Class<?>[]{String.class},route);}
 @Test public void pickerReturnsToItsEntryAfterBackAndSelection()throws Exception{
  try(ActivityScenario<NativeChatActivity> screen=ActivityScenario.launch(NativeChatActivity.class)){
   screen.onActivity(a->{try{
    NativeConnection c=(NativeConnection)get(a,"connection");assertTrue("Existing paired device required",c.paired());
    for(String route:new String[]{"sessions","settings","connection"}){
     nav(a,route);nav(a,"computers");a.onBackPressed();assertEquals(route,get(a,"route"));
     nav(a,"computers");invoke(a,"selectComputer",new Class<?>[]{NativeConnection.class},c);assertEquals(route,get(a,"route"));
    }
    nav(a,"sessions");nav(a,"computers");
   }catch(Exception e){throw new AssertionError(e);}});
   screen.recreate();screen.onActivity(a->{a.onBackPressed();try{assertEquals("sessions",get(a,"route"));}catch(Exception e){throw new AssertionError(e);}});
  }
 }
 @Test public void captureSyntheticSessionsOnly()throws Exception{
  Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("captureDemo")));
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertFalse(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
  NativeConnection demo=new NativeConnection(context,"demo-"+UUID.randomUUID());demo.name("演示电脑");demo.authenticated=true;demo.historyLoaded=true;demo.snapshot=NativeConnection.obj("threads",new JSONArray(),"items",new JSONArray(),"deviceOnline",true);
  String[] titles={"整理项目待办","优化示例页面","检查测试结果","编写使用说明","整理演示资料"};String[] previews={"将示例需求整理为清晰的任务清单。","统一页面布局、按钮和卡片间距。","汇总测试结果，标记需要跟进的事项。","补充安装步骤和常见操作说明。","按类别归纳示例文件，便于后续查找。"};
  for(int i=0;i<titles.length;i++)demo.historyThreads.put(NativeConnection.obj("id","demo-session-"+i,"title",titles[i],"preview",previews[i],"status","idle","goalStateKnown",true,"updatedAt",0));
  Object[] previous=new Object[1];
  try(ActivityScenario<NativeChatActivity> screen=ActivityScenario.launch(NativeChatActivity.class)){
   screen.onActivity(a->{try{previous[0]=get(a,"connection");nav(a,"settings");set(a,"connection",demo);set(a,"query","");set(a,"route","sessions");invoke(a,"build",new Class<?>[]{});}catch(Exception e){throw new AssertionError(e);}});
   Thread.sleep(500);
   screen.onActivity(a->{try{
    View root=(View)get(a,"root");Bitmap image=Bitmap.createBitmap(root.getWidth(),root.getHeight(),Bitmap.Config.ARGB_8888);root.draw(new Canvas(image));
    try(FileOutputStream out=new FileOutputStream(new File(context.getExternalFilesDir(null),"sessions-demo.png"))){assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,out));}image.recycle();
    set(a,"connection",previous[0]);nav(a,"settings");
   }catch(Exception e){throw new AssertionError(e);}});
  }finally{demo.dispose();demo.local.clear();context.deleteSharedPreferences("native-device-"+demo.computerId);}
 }
}
