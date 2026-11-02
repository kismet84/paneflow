package com.codexpane.companion;

import android.content.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.util.*;
import okhttp3.*;
import okio.ByteString;
import static org.junit.Assert.*;

/** Isolated on-device checks: no production bindings, socket connections, or lock-screen actions. */
@RunWith(AndroidJUnit4.class)
public class NativeReliabilityTest {
    private static final class IsolatedContext extends ContextWrapper {
        final String prefix="test05-"+UUID.randomUUID()+"-";
        final File folder;
        final Set<String> prefs=new HashSet<>();
        IsolatedContext(){super(InstrumentationRegistry.getInstrumentation().getTargetContext());folder=new File(super.getNoBackupFilesDir(),prefix);assertTrue(folder.mkdirs());}
        @Override public SharedPreferences getSharedPreferences(String name,int mode){prefs.add(prefix+name);return super.getSharedPreferences(prefix+name,mode);}
        @Override public File getNoBackupFilesDir(){return folder;}
        void cleanup(){for(String name:prefs)super.deleteSharedPreferences(name);File[] files=folder.listFiles();if(files!=null)for(File file:files)assertTrue(file.delete());assertTrue(folder.delete());}
    }
    private static void set(Object target,String name,Object value)throws Exception {Field field=target.getClass().getDeclaredField(name);field.setAccessible(true);field.set(target,value);}
    private static void event(NativeConnection c,JSONObject value)throws Exception {Method method=NativeConnection.class.getDeclaredMethod("applyEvent",JSONObject.class);method.setAccessible(true);method.invoke(c,value);}
    @Test public void encryptedDraftsAreDurableAndIsolatedAndCorruptionIsPreserved()throws Exception {
        IsolatedContext context=new IsolatedContext();
        try {
            NativeLocalStore first=new NativeLocalStore(context,"computer-a");first.text("drafts","same-thread","secret draft A");
            NativeLocalStore second=new NativeLocalStore(context,"computer-b");second.text("drafts","same-thread","secret draft B");
            assertEquals("secret draft A",new NativeLocalStore(context,"computer-a").text("drafts","same-thread"));
            assertEquals("secret draft B",new NativeLocalStore(context,"computer-b").text("drafts","same-thread"));
            File path=new File(context.folder,"pane-state-computer-a.enc");byte[] encrypted=Files.readAllBytes(path.toPath());assertFalse(new String(encrypted,StandardCharsets.UTF_8).contains("secret draft"));
            byte[] corrupted=encrypted.clone();corrupted[corrupted.length-1]^=1;Files.write(path.toPath(),corrupted);
            NativeLocalStore broken=new NativeLocalStore(context,"computer-a");assertFalse(broken.failure().isEmpty());
            try{broken.text("drafts","same-thread","overwrite");fail("Corrupt data must not be replaced");}catch(IllegalStateException expected){}
            assertArrayEquals(corrupted,Files.readAllBytes(path.toPath()));second.clear();assertTrue(path.exists());
        }finally{context.cleanup();}
    }
    @Test public void legacyIdentityAndBackgroundChoiceSurviveComputerManagement()throws Exception {
        IsolatedContext context=new IsolatedContext();String device=UUID.randomUUID().toString();KeyPair key=NativeIdentity.signing(device);NativeConnections manager=null;
        try {
            String binding=NativeConnection.obj("deviceId",device,"relayOrigin","https://test.example","channelId","legacy-channel").toString();
            context.getSharedPreferences("native-device",0).edit().putString("binding",binding).putBoolean("background",true).commit();
            Constructor<NativeConnections> constructor=NativeConnections.class.getDeclaredConstructor(Context.class);constructor.setAccessible(true);manager=constructor.newInstance(context);
            NativeConnection legacy=manager.active();assertTrue(legacy.paired());assertTrue(legacy.background());
            NativeConnection added=manager.add();assertFalse(added.background());assertFalse(added.paired());added.name("Second computer");added.local.text("drafts","shared-id","second");legacy.local.text("drafts","shared-id","first");
            manager.select(legacy.computerId);assertEquals("first",manager.active().local.text("drafts","shared-id"));manager.remove(added.computerId);
            assertEquals(1,manager.all().size());assertEquals(binding,context.getSharedPreferences("native-device",0).getString("binding",""));assertArrayEquals(key.getPublic().getEncoded(),NativeIdentity.existing(device).getPublic().getEncoded());assertEquals("first",legacy.local.text("drafts","shared-id"));
        }finally{if(manager!=null)for(NativeConnection c:manager.all())c.dispose();NativeIdentity.remove(device);context.cleanup();}
    }
    @Test public void requestIsDurableBeforeTransportAndNeverAutomaticallyReplayed()throws Exception {
        IsolatedContext context=new IsolatedContext();NativeConnection c=new NativeConnection(context,"requests");
        try {
            c.authenticated=true;set(c,"sessionKey",new byte[32]);set(c,"sessionId","test-session");final int[] sends={0};
            set(c,"socket",new WebSocket(){public Request request(){return new Request.Builder().url("https://test.example").build();}public long queueSize(){return 0;}public boolean send(String text){sends[0]++;assertEquals(1,c.requests("t").length());assertEquals("waiting",c.requests("t").optJSONObject(0).optString("status"));return false;}public boolean send(ByteString b){return false;}public boolean close(int code,String reason){return true;}public void cancel(){}});
            String requestId=UUID.randomUUID().toString();JSONObject command=NativeConnection.obj("type","turn.send","threadId","t","text","do not replay","requestId",requestId);
            try{c.command(command);fail("Transport fails");}catch(IllegalStateException expected){}
            assertEquals("unknown",new NativeLocalStore(context,"requests").section("requests").getJSONObject(requestId).getString("status"));
            try{c.command(command);fail("Duplicate stable request id must not be sent");}catch(IllegalStateException expected){}
            assertEquals(1,sends[0]);c.disconnect();assertEquals(1,sends[0]);
            event(c,NativeConnection.obj("type","request.status","records",new JSONArray().put(NativeConnection.obj("requestId",requestId,"status","completed"))));assertEquals("completed",c.requests("t").getJSONObject(0).getString("status"));
        }finally{c.dispose();context.cleanup();}
    }
    @Test public void historyPrependDeduplicatesAndIgnoresAnotherThread()throws Exception {
        IsolatedContext context=new IsolatedContext();NativeConnection c=new NativeConnection(context,"history");
        try {
            c.snapshot=NativeConnection.obj("activeThreadId","t","items",new JSONArray().put(NativeConnection.obj("id","recent","kind","agent","markdown","current")),"threads",new JSONArray());
            set(c,"bodyThread","t");set(c,"bodyRequest","page-1");
            event(c,NativeConnection.obj("type","history.page","requestId","page-1","threadId","other","items",new JSONArray().put(NativeConnection.obj("id","wrong")),"nextCursor",JSONObject.NULL));assertEquals(1,c.chatItems().length());
            event(c,NativeConnection.obj("type","history.page","requestId","page-1","threadId","t","items",new JSONArray().put(NativeConnection.obj("id","old","kind","user","text","first")).put(NativeConnection.obj("id","recent","kind","agent","markdown","stale")),"nextCursor","next"));
            assertEquals(2,c.chatItems().length());assertEquals("old",c.chatItems().getJSONObject(0).getString("id"));assertEquals("current",c.chatItems().getJSONObject(1).getString("markdown"));
            set(c,"bodyRequest","page-2");event(c,NativeConnection.obj("type","history.page","requestId","page-2","threadId","t","items",new JSONArray().put(NativeConnection.obj("id","older","kind","user","text","earliest")).put(NativeConnection.obj("id","old","kind","user","text","first")),"nextCursor",JSONObject.NULL));assertEquals(3,c.chatItems().length());assertEquals("older",c.chatItems().getJSONObject(0).getString("id"));
        }finally{c.dispose();context.cleanup();}
    }
    @Test public void overlappingRecentSubsetKeepsChronologyAndUpdatedHistoryWins()throws Exception {
        JSONArray snapshot=new JSONArray().put(NativeConnection.obj("id","old","text","old")).put(NativeConnection.obj("id","recent","text","live"));
        JSONArray subset=new JSONArray().put(NativeConnection.obj("id","recent","text","page"));
        JSONArray combined=NativeConnection.mergeItems(subset,snapshot,false);
        assertEquals("old",combined.getJSONObject(0).getString("id"));assertEquals("recent",combined.getJSONObject(1).getString("id"));assertEquals("live",combined.getJSONObject(1).getString("text"));
        JSONArray page=new JSONArray().put(NativeConnection.obj("id","older","text","earliest")).put(NativeConnection.obj("id","old","text","updated"));
        combined=NativeConnection.mergeItems(combined,page,true);assertEquals(3,combined.length());assertEquals("older",combined.getJSONObject(0).getString("id"));assertEquals("updated",combined.getJSONObject(1).getString("text"));
    }
    private JSONObject publicKey(KeyPair key){return NativeConnection.obj("kty","EC","crv","P-256","x",NativeCrypto.x(key.getPublic()),"y",NativeCrypto.y(key.getPublic()));}
    @Test public void rePairCannotReplaceComputerIdentityOrMixLocalData()throws Exception {
        IsolatedContext context=new IsolatedContext();NativeConnection c=new NativeConnection(context,"pair-boundary");
        try {
            JSONObject signing=publicKey(NativeCrypto.ephemeral()),agreement=publicKey(NativeCrypto.ephemeral());
            JSONObject original=NativeConnection.obj("channelId","computer-a","desktopSigningPublicKey",signing,"desktopAgreementPublicKey",agreement);set(c,"binding",original);c.local.text("drafts","thread","keep A");
            c.validatePairingComputer(new JSONObject(original.toString())); // Same computer may re-pair without clearing its data.
            JSONObject different=new JSONObject(original.toString());different.put("channelId","computer-b");try{c.validatePairingComputer(different);fail("Different channel accepted");}catch(SecurityException expected){}
            different=new JSONObject(original.toString());different.put("desktopSigningPublicKey",publicKey(NativeCrypto.ephemeral()));try{c.validatePairingComputer(different);fail("Different signing key accepted");}catch(SecurityException expected){}
            different=new JSONObject(original.toString());different.put("desktopAgreementPublicKey",publicKey(NativeCrypto.ephemeral()));try{c.validatePairingComputer(different);fail("Different agreement key accepted");}catch(SecurityException expected){}
            assertEquals("keep A",c.local.text("drafts","thread"));assertFalse(c.pairingActive());
        }finally{c.dispose();context.cleanup();}
    }
    @SuppressWarnings("unchecked")
    @Test public void notificationSwitchRejectsAnotherComputersSavedBundleAndDismissesOldDialogs()throws Exception {
        IsolatedContext context=new IsolatedContext();Constructor<NativeConnections> constructor=NativeConnections.class.getDeclaredConstructor(Context.class);constructor.setAccessible(true);NativeConnections manager=constructor.newInstance(context);NativeConnection a=manager.active(),b=manager.add();manager.select(a.computerId);
        a.local.text("drafts","shared-thread","draft A");a.local.save("newForm",NativeConnection.obj("cwd","A-directory","model","A-model"));
        b.local.text("drafts","shared-thread","draft B");b.local.save("newForm",NativeConnection.obj("cwd","B-directory","model","B-model"));
        Field singleton=NativeConnections.class.getDeclaredField("instance");singleton.setAccessible(true);Object original=singleton.get(null);singleton.set(null,manager);
        try(androidx.test.core.app.ActivityScenario<NativeChatActivity> scenario=androidx.test.core.app.ActivityScenario.launch(NativeChatActivity.class)){
            scenario.onActivity(activity->{try{
                Intent initialIntent=new Intent(activity.getIntent());android.os.Bundle old=new android.os.Bundle();activity.onSaveInstanceState(old);
                set(activity,"pendingNew","old-new");set(activity,"pendingFork","old-fork");set(activity,"pendingNavigate","old-target");
                Method sheet=NativeChatActivity.class.getDeclaredMethod("sheet",String.class,android.widget.LinearLayout.class);sheet.setAccessible(true);sheet.invoke(activity,"Old computer dialog",new android.widget.LinearLayout(activity));
                activity.onNewIntent(new Intent().setAction("com.codexpane.OPEN_CHAT").putExtra("computerId",b.computerId));
                Method restore=NativeChatActivity.class.getDeclaredMethod("restoreState",android.os.Bundle.class);restore.setAccessible(true);restore.invoke(activity,old);
                Field drafts=NativeChatActivity.class.getDeclaredField("drafts");drafts.setAccessible(true);assertEquals("draft B",((Map<String,String>)drafts.get(activity)).get("shared-thread"));
                for(String name:new String[]{"pendingNew","pendingFork","pendingNavigate"}){Field field=NativeChatActivity.class.getDeclaredField(name);field.setAccessible(true);assertEquals("",field.get(activity));}
                Field cwd=NativeChatActivity.class.getDeclaredField("newDirectory");cwd.setAccessible(true);assertEquals("B-directory",cwd.get(activity));Field model=NativeChatActivity.class.getDeclaredField("newModel");model.setAccessible(true);assertEquals("B-model",model.get(activity));
                Field dialogs=NativeChatActivity.class.getDeclaredField("dialogs");dialogs.setAccessible(true);assertTrue(((Set<?>)dialogs.get(activity)).isEmpty());assertEquals(b,NativeConnection.get(activity));
                assertTrue(initialIntent.filterEquals(activity.getIntent()));assertTrue(activity.getIntent().getBooleanExtra("paneflow.notificationConsumed",false));assertFalse(activity.getIntent().hasExtra("computerId"));
                // Notification selected B, then the person selected A. Recreation must retain A.
                Method select=NativeChatActivity.class.getDeclaredMethod("selectComputer",NativeConnection.class);select.setAccessible(true);select.invoke(activity,a);assertEquals(a,NativeConnection.get(activity));
            }catch(Exception e){throw new AssertionError(e);}});
            scenario.recreate();scenario.onActivity(activity->{assertEquals(a.computerId,NativeConnection.get(activity).computerId);assertEquals("draft B",b.local.text("drafts","shared-thread"));assertEquals("draft A",a.local.text("drafts","shared-thread"));});
        }finally{singleton.set(null,original);for(NativeConnection c:manager.all())c.dispose();context.cleanup();}
    }

    private static Object getField(Object target,String name)throws Exception {Field field=target.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(target);}
    private static void invokeUi(NativeChatActivity activity,String name)throws Exception {Method method=NativeChatActivity.class.getDeclaredMethod(name);method.setAccessible(true);method.invoke(activity);}
    private static JSONArray longMessages(int start,int end){JSONArray items=new JSONArray();for(int i=start;i<end;i++)items.put(NativeConnection.obj("id","long-item-"+i,"kind",i%2==0?"user":"agent",i%2==0?"text":"markdown","Message "+i+" — isolated long-history fixture.\nSecond line preserves realistic row height.","status","completed"));return items;}
    private static android.widget.ListView list(NativeChatActivity activity)throws Exception {return (android.widget.ListView)getField(activity,"chatList");}
    private static String firstItem(android.widget.ListView list){Object item=list.getAdapter().getItem(list.getFirstVisiblePosition());return item instanceof JSONObject?((JSONObject)item).optString("id"):"header";}
    private static void awaitList(androidx.test.core.app.ActivityScenario<NativeChatActivity> scenario,int expectedCount)throws Exception {
        for(int attempt=0;attempt<50;attempt++){final boolean[] ready={false};scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);ready[0]=view!=null&&view.getCount()==expectedCount&&view.getChildCount()>0&&!view.isLayoutRequested();}catch(Exception e){throw new AssertionError(e);}});if(ready[0]){InstrumentationRegistry.getInstrumentation().waitForIdleSync();return;}Thread.sleep(100);}throw new AssertionError("List layout did not settle for "+expectedCount+" rows");
    }
    private static void historyPage(NativeConnection c,String request,int start,int end,String cursor)throws Exception {set(c,"bodyThread","long-thread");set(c,"bodyRequest",request);event(c,NativeConnection.obj("type","history.page","requestId",request,"threadId","long-thread","items",longMessages(start,end),"nextCursor",cursor==null?JSONObject.NULL:cursor));}
    @Test public void longHistoryKeepsVisibleAnchorAndReusesListAcrossPagesStreamAndRecreation()throws Exception {
        IsolatedContext context=new IsolatedContext();Constructor<NativeConnections> constructor=NativeConnections.class.getDeclaredConstructor(Context.class);constructor.setAccessible(true);NativeConnections manager=constructor.newInstance(context);NativeConnection c=manager.active();
        // Isolated render fixture only: absent key causes resume to fail locally before any socket is opened.
        set(c,"binding",NativeConnection.obj("deviceId","isolated-long-history-no-key"));
        c.snapshot=NativeConnection.obj("activeThreadId","long-thread","activeThreadTitle","Long history fixture","activeTurnId",JSONObject.NULL,"turnStatus","idle","items",longMessages(400,700),"threads",new JSONArray(),"capabilities",new JSONArray().put("historyPagination"));
        Field singleton=NativeConnections.class.getDeclaredField("instance");singleton.setAccessible(true);Object original=singleton.get(null);singleton.set(null,manager);
        final Object[] listIdentity={null},adapterIdentity={null},unchangedVisibleChild={null};final String[] anchor={null};final int[] offset={0};
        try(androidx.test.core.app.ActivityScenario<NativeChatActivity> scenario=androidx.test.core.app.ActivityScenario.launch(NativeChatActivity.class)){
            scenario.onActivity(activity->{try{Method navigate=NativeChatActivity.class.getDeclaredMethod("navigate",String.class);navigate.setAccessible(true);navigate.invoke(activity,"chat");}catch(Exception e){throw new AssertionError(e);}});
            awaitList(scenario,301);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);view.setSelectionFromTop(151,-11);}catch(Exception e){throw new AssertionError(e);}});
            awaitList(scenario,301);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);anchor[0]=firstItem(view);offset[0]=view.getChildAt(0).getTop();listIdentity[0]=view;adapterIdentity[0]=view.getAdapter();assertTrue("Reader must be in the middle of the loaded history",view.getFirstVisiblePosition()>100&&view.getFirstVisiblePosition()<200);assertTrue(anchor[0].startsWith("long-item-"));assertTrue("Rows must be virtualized",view.getChildCount()<30);historyPage(c,"older-page-one",200,420,"cursor-200");invokeUi(activity,"renderChat");}catch(Exception e){throw new AssertionError(e);}});
            awaitList(scenario,501);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);assertSame(listIdentity[0],view);assertSame(adapterIdentity[0],view.getAdapter());assertEquals("First prepend changed item anchor",anchor[0],firstItem(view));assertEquals("First prepend changed pixel offset",offset[0],view.getChildAt(0).getTop());historyPage(c,"older-page-two",0,220,null);invokeUi(activity,"renderChat");}catch(Exception e){throw new AssertionError(e);}});
            awaitList(scenario,701);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);assertSame(listIdentity[0],view);assertSame(adapterIdentity[0],view.getAdapter());assertEquals("Second prepend changed item anchor",anchor[0],firstItem(view));assertEquals("Second prepend changed pixel offset",offset[0],view.getChildAt(0).getTop());assertTrue("700 messages must not create 700 row Views",view.getChildCount()<30);
                Set<String> ids=new HashSet<>();for(int i=1;i<view.getCount();i++){JSONObject item=(JSONObject)view.getAdapter().getItem(i);assertTrue("Duplicate history item",ids.add(item.getString("id")));assertEquals("History order", "long-item-"+(i-1),item.getString("id"));}assertEquals(700,ids.size());
                unchangedVisibleChild[0]=((android.view.ViewGroup)view.getChildAt(0)).getChildAt(0);
                event(c,NativeConnection.obj("type","item.upsert","threadId","long-thread","item",NativeConnection.obj("id","long-item-699","kind","agent","markdown","Streaming update at the end of the conversation","status","running")));invokeUi(activity,"renderChat");
            }catch(Exception e){throw new AssertionError(e);}});
            awaitList(scenario,701);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);assertSame(listIdentity[0],view);assertSame(adapterIdentity[0],view.getAdapter());assertEquals(anchor[0],firstItem(view));assertEquals("Stream moved reader",offset[0],view.getChildAt(0).getTop());assertSame("Unchanged visible message was rebuilt",unchangedVisibleChild[0],((android.view.ViewGroup)view.getChildAt(0)).getChildAt(0));invokeUi(activity,"saveReading");JSONObject persisted=new NativeLocalStore(context,c.computerId).section("reading").getJSONObject("long-thread");assertEquals(anchor[0],persisted.getString("id"));}catch(Exception e){throw new AssertionError(e);}});
            scenario.recreate();awaitList(scenario,701);
            scenario.onActivity(activity->{try{android.widget.ListView view=list(activity);assertEquals("Recreation lost saved item",anchor[0],firstItem(view));assertEquals("Recreation lost saved pixel offset",offset[0],view.getChildAt(0).getTop());assertTrue(view.getChildCount()<30);assertEquals(700,c.chatItems().length());}catch(Exception e){throw new AssertionError(e);}});
        }finally{singleton.set(null,original);for(NativeConnection owned:manager.all())owned.dispose();context.cleanup();}
    }

}
