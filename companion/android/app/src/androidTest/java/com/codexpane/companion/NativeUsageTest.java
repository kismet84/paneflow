package com.codexpane.companion;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeUsageTest {
    private Object get(Object o,String name)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
    private void set(Object o,String name,Object value)throws Exception{Field f=o.getClass().getDeclaredField(name);f.setAccessible(true);f.set(o,value);}
    private Object call(Object o,String name,Class<?>[] types,Object...args)throws Exception{Method m=o.getClass().getDeclaredMethod(name,types);m.setAccessible(true);return m.invoke(o,args);}
    private void call(Object o,String name)throws Exception{call(o,name,new Class<?>[]{});}
    private String text(View view){StringBuilder out=new StringBuilder();if(view instanceof TextView)out.append(((TextView)view).getText()).append("\n");if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++)out.append(text(group.getChildAt(i)));}return out.toString();}
    private NativeConnection isolated(){Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();return new NativeConnection(context,"usage-test-"+UUID.randomUUID());}
    @Test public void usageReadsAreUntrackedAndCorrelatedPerComputer()throws Exception {
        NativeConnection first=isolated(),second=isolated();
        try {
            assertEquals(false,call(first,"tracked",new Class<?>[]{String.class},"usage.get"));
            assertFalse(NativeConnection.isReadOnlyWrite(NativeConnection.obj("readOnly",true,"activeThreadId","thread"),NativeConnection.obj("type","usage.get","threadId","thread")));
            String request=UUID.randomUUID().toString();first.usageRequest=request;
            JSONObject usage=NativeConnection.obj("updatedAt",1000,"limitsAvailable",true,"windows",new JSONArray(),"tokensAvailable",true,"lifetimeTokens",1234);
            call(first,"applyEvent",new Class<?>[]{JSONObject.class},NativeConnection.obj("type","usage.snapshot","requestId","stale","usage",usage));assertEquals(0,first.usage.length());assertEquals(request,first.usageRequest);
            call(first,"applyEvent",new Class<?>[]{JSONObject.class},NativeConnection.obj("type","usage.snapshot","requestId",request,"usage",usage));assertEquals(1234,first.usage.getInt("lifetimeTokens"));assertEquals("",first.usageRequest);assertEquals(0,second.usage.length());
            first.usageRequest=UUID.randomUUID().toString();first.disconnect();assertEquals("",first.usageRequest);assertEquals(1234,first.usage.getInt("lifetimeTokens"));assertTrue(first.usageError.contains("连接中断"));
        }finally{first.dispose();second.dispose();}
    }
    @Test public void usagePageShowsMissingDataOfflineAndQuotaWithoutChangingReadonlyDrafts(){
        NativeConnection isolated=isolated();isolated.snapshot=NativeConnection.obj("threads",new JSONArray(),"items",new JSONArray(),"capabilities",new JSONArray().put("usageSummary"),"readOnly",true,"activeThreadId","thread","deviceOnline",true);
        isolated.usage=NativeConnection.obj("updatedAt",1000,"limitsAvailable",true,"windows",new JSONArray().put(NativeConnection.obj("name","五小时额度","usedPercent",25,"windowMinutes",300)),"tokensAvailable",true,"lifetimeTokens",1200,"peakDailyTokens",JSONObject.NULL);
        try(ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class)){
            scenario.onActivity(a->{Object previous=null;try{
                previous=get(a,"connection");set(a,"connection",isolated);set(a,"route","usage");call(a,"build");String shown=text((View)get(a,"root"));
                assertTrue(shown.contains("用量管理"));assertTrue(shown.contains("电脑离线"));assertTrue(shown.contains("已用 25.0%"));assertTrue(shown.contains("剩余 75.0%"));assertTrue(shown.contains("5 小时额度"));assertEquals("每周额度",NativeChatActivity.usageWindow(10080));assertFalse(shown.contains("Token"));assertFalse(shown.contains("1,200"));assertFalse(shown.contains("不同电脑可能共用"));assertFalse(shown.contains("约 US$"));
                assertEquals("未提供",NativeChatActivity.usageNumber(isolated.usage,"peakDailyTokens"));assertEquals("未提供",NativeChatActivity.usageNumber(isolated.usage,"currentStreakDays"));assertEquals("0",NativeChatActivity.usageNumber(NativeConnection.obj("n",0),"n"));
                isolated.authenticated=true;NativeConnection.put(isolated.snapshot,"capabilities",new JSONArray());call(a,"renderUsage");assertTrue(text((View)get(a,"root")).contains("电脑需升级"));
                assertEquals("状态待确认",call(a,"statusLabel",new Class<?>[]{String.class},"unknown"));
            }catch(Exception e){throw new AssertionError(e);}finally{try{set(a,"connection",previous);set(a,"route","settings");call(a,"build");}catch(Exception e){throw new AssertionError(e);}}});
        }finally{isolated.dispose();}
    }
}
