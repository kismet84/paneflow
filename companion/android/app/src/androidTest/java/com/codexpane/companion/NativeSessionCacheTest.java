package com.codexpane.companion;

import android.content.*;
import android.app.KeyguardManager;
import android.widget.ScrollView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.*;
import java.util.UUID;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

public class NativeSessionCacheTest {
 private static Context context(){return InstrumentationRegistry.getInstrumentation().getTargetContext();}
 private static void main(Runnable r){InstrumentationRegistry.getInstrumentation().runOnMainSync(r);}
 private static Object call(Object o,String name,Class<?>[] types,Object...args)throws Exception{Method m=o.getClass().getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(o,args);}
 private static Object field(Object o,String name)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
 private static void event(NativeConnection c,JSONObject e)throws Exception{call(c,"applyEvent",new Class<?>[]{JSONObject.class},e);}
 private static void await(java.util.function.BooleanSupplier predicate)throws Exception{long until=System.currentTimeMillis()+60000;while(System.currentTimeMillis()<until){AtomicBoolean ok=new AtomicBoolean();main(()->ok.set(predicate.getAsBoolean()));if(ok.get())return;Thread.sleep(100);}fail("Timed out");}
 @Test public void cacheSurvivesDisconnectAndRecreationAndRejectsStalePages()throws Exception{
  String id="cache-test-"+UUID.randomUUID();NativeConnection c=new NativeConnection(context(),id),restored=null,other=new NativeConnection(context(),"cache-other-"+UUID.randomUUID());
  try{
   c.historyRequest="first";c.historyReset=true;
   event(c,NativeConnection.obj("type","thread.page","requestId","first","threads",new JSONArray().put(NativeConnection.obj("id","cached","title","Cached title")),"nextCursor","next"));
   c.disconnect();assertTrue(c.historyLoaded);assertEquals(1,c.historyThreads.length());
   context().getSharedPreferences("native-device-"+id,0).edit().putString("binding","{}").commit();
   restored=new NativeConnection(context(),id);assertEquals("cached",restored.historyThreads.getJSONObject(0).getString("id"));assertEquals("next",restored.historyCursor);assertEquals(0,other.historyThreads.length());
   c.authenticated=true;c.historyRequest="refresh";c.requestHistory(true,"");assertEquals("refresh",c.historyRequest);assertEquals(1,c.historyThreads.length());
   event(c,NativeConnection.obj("type","thread.page","requestId","stale","threads",new JSONArray(),"nextCursor",JSONObject.NULL));assertEquals(1,c.historyThreads.length());
   event(c,NativeConnection.obj("type","command.result","requestId","refresh","ok",false,"message","offline"));assertEquals(1,c.historyThreads.length());assertFalse(c.historyError.isEmpty());
   c.historyRequest="next";c.historyReset=false;
   event(c,NativeConnection.obj("type","thread.page","requestId","next","threads",new JSONArray().put(NativeConnection.obj("id","cached","title","Updated")).put(NativeConnection.obj("id","older")),"nextCursor",JSONObject.NULL));assertEquals(2,c.historyThreads.length());
   c.invalidateHistory("search");assertEquals(0,c.historyThreads.length());assertEquals("",c.historyCursor);
  }finally{c.dispose();if(restored!=null)restored.dispose();other.dispose();c.local.clear();other.local.clear();context().deleteSharedPreferences("native-device-"+id);context().deleteSharedPreferences("native-device-"+other.computerId);}
 }
 @Test public void liveNavigationUsesCacheAndDoubleTapAndReconnectRefresh()throws Exception{
  Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("liveSessionCache")));
  assertFalse(context().getSystemService(KeyguardManager.class).isKeyguardLocked());
  try(ActivityScenario<NativeChatActivity> screen=ActivityScenario.launch(NativeChatActivity.class)){
   NativeConnection c=NativeConnections.get(context()).active();await(()->c.authenticated&&c.historyLoaded&&c.historyRequest.isEmpty());
   AtomicInteger pages=new AtomicInteger();NativeConnection.Listener listener=e->{if("thread.page".equals(e.optString("type")))pages.incrementAndGet();};main(()->c.add(listener));
   try{
    screen.onActivity(a->{try{call(a,"navigate",new Class<?>[]{String.class},"sessions");call(a,"navigate",new Class<?>[]{String.class},"settings");call(a,"navigate",new Class<?>[]{String.class},"sessions");assertEquals("",c.historyRequest);}catch(Exception e){throw new AssertionError(e);}});
    Thread.sleep(800);assertEquals(0,pages.get());
    screen.onActivity(a->{try{ScrollView v=(ScrollView)field(a,"scroll");v.scrollTo(0,100);}catch(Exception e){throw new AssertionError(e);}});
    screen.onActivity(a->{try{call(a,"navigate",new Class<?>[]{String.class},"settings");call(a,"navigate",new Class<?>[]{String.class},"sessions");}catch(Exception e){throw new AssertionError(e);}});
    Thread.sleep(400);screen.onActivity(a->{try{assertEquals(100,((ScrollView)field(a,"scroll")).getScrollY());call(a,"selectTab",new Class<?>[]{String.class},"sessions");assertEquals("",c.historyRequest);call(a,"selectTab",new Class<?>[]{String.class},"sessions");assertFalse(c.historyRequest.isEmpty());int size=c.historyThreads.length();assertTrue(size>0);call(a,"selectTab",new Class<?>[]{String.class},"sessions");call(a,"selectTab",new Class<?>[]{String.class},"sessions");assertEquals(size,c.historyThreads.length());}catch(Exception e){throw new AssertionError(e);}});
    await(()->pages.get()==1&&c.historyRequest.isEmpty());assertEquals(5,c.historyThreads.length());
    main(()->{try{c.requestHistory(false,"");}catch(Exception e){throw new AssertionError(e);}});await(()->pages.get()==2&&c.historyRequest.isEmpty());assertEquals(15,c.historyThreads.length());
    screen.onActivity(a->{try{call(a,"navigate",new Class<?>[]{String.class},"settings");call(a,"navigate",new Class<?>[]{String.class},"sessions");assertEquals(15,c.historyThreads.length());assertEquals("",c.historyRequest);call(a,"navigate",new Class<?>[]{String.class},"settings");}catch(Exception e){throw new AssertionError(e);}});
    main(c::reconnect);await(()->c.authenticated&&pages.get()==3&&c.historyRequest.isEmpty());assertEquals(5,c.historyThreads.length());
    assertFalse(context().getSystemService(KeyguardManager.class).isKeyguardLocked());
   }finally{main(()->c.remove(listener));}
  }
 }
}
