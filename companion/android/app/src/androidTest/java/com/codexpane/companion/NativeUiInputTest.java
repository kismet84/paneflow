package com.codexpane.companion;

import android.app.Activity;
import android.os.Bundle;
import android.util.Base64;
import android.widget.EditText;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.ViewMatchers.*;

/** Test APK only. Types through normal UI; never changes credentials or approves desktop pairing. */
@RunWith(AndroidJUnit4.class)
public class NativeUiInputTest {
    private ActivityScenario<NativeChatActivity> launched;
    private String phase="launch";

    private NativeChatActivity resumedActivity() {
        AtomicReference<NativeChatActivity> found = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            for (Activity activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                if (activity instanceof NativeChatActivity) found.set((NativeChatActivity)activity);
            }
        });
        return found.get();
    }

    private NativeChatActivity ensureActivity() throws Exception {
        NativeChatActivity existing = resumedActivity();
        if (existing != null) return existing;
        // Instrumentation may restart its target process. This is the ordinary native UI, not an exported backdoor.
        launched = ActivityScenario.launch(NativeChatActivity.class);
        for (int i = 0; i < 100; i++) {
            existing = resumedActivity();
            if (existing != null) return existing;
            Thread.sleep(100);
        }
        throw new IllegalStateException("Native screen unavailable");
    }

    private boolean pairingDialogVisible() {
        try {
            onView(withText("开始配对")).inRoot(isDialog()).check(matches(isDisplayed()));
            return true;
        } catch (RuntimeException | AssertionError ignored) { return false; }
    }

    private android.view.View find(android.view.View root, java.util.function.Predicate<android.view.View> predicate) {
        if (predicate.test(root)) return root;
        if (root instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                android.view.View match = find(group.getChildAt(i), predicate);
                if (match != null) return match;
            }
        }
        return null;
    }
    private void withView(java.util.function.Predicate<android.view.View> predicate, java.util.function.Consumer<android.view.View> action) throws Exception {
        for (int attempt = 0; attempt < 100; attempt++) {
            AtomicReference<Boolean> done = new AtomicReference<>(false);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                java.util.List<android.view.View> roots = android.view.inspector.WindowInspector.getGlobalWindowViews();
                for (int i = roots.size() - 1; i >= 0; i--) {
                    android.view.View match = find(roots.get(i), predicate);
                    if (match != null) { action.accept(match); done.set(true); break; }
                }
            });
            if (done.get()) return;
            Thread.sleep(100);
        }
        throw new IllegalStateException("UI control unavailable");
    }
    private void clickLabel(String label) throws Exception {
        phase=label;
        withView(v -> v instanceof android.widget.TextView && label.contentEquals(((android.widget.TextView)v).getText()) && v.isShown() && v.isEnabled(), v -> {android.view.View target=v;while(!target.isClickable() && target.getParent() instanceof android.view.View)target=(android.view.View)target.getParent();target.performClick();});
    }
    private void typeInto(boolean pairing, String value) throws Exception {
        withView(v -> v instanceof EditText && v.isShown() && (pairing ? ((EditText)v).getHint().toString().startsWith("http") : "发消息…".contentEquals(((EditText)v).getHint())), v -> ((EditText)v).setText(value));
    }
    @Test public void enterThroughNativeUi() {
        try {
            Bundle args = InstrumentationRegistry.getArguments();
            String action = args.getString("action", "");
            String encoded = args.getString("valueBase64", "");
            if (!("pair".equals(action) || "relay".equals(action) || "send".equals(action) || "new".equals(action) || "fork".equals(action) || "search".equals(action)) || encoded.isEmpty() || encoded.length() > 80000 || !encoded.matches("[A-Za-z0-9_-]+={0,2}")) throw new IllegalArgumentException("Invalid test arguments");
            String value = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8);
            NativeChatActivity activity = ensureActivity();
            if (!"pair".equals(action) && !"relay".equals(action)) { for(int wait=0;wait<300;wait++){AtomicReference<Boolean> ready=new AtomicReference<>(false);InstrumentationRegistry.getInstrumentation().runOnMainSync(()->ready.set(NativeConnection.get(activity).authenticated && NativeConnection.get(activity).snapshot.optJSONArray("models")!=null && NativeConnection.get(activity).snapshot.optJSONArray("models").length()>0));if(ready.get())break;Thread.sleep(100);}}
            if ("pair".equals(action)) {
                {
                    AtomicReference<Boolean> paired = new AtomicReference<>(false);
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> paired.set(NativeConnection.get(activity).paired()));
                    if (paired.get()) {
                        withView(v -> "设置标签".equals(String.valueOf(v.getContentDescription())), v -> v.performClick());
                        clickLabel("配对其他电脑");
                    } else clickLabel("粘贴配对链接");
                }
                typeInto(true, value);
                clickLabel("继续");
                boolean completed = false;
                for (int i = 0; i < 1200; i++) {
                    AtomicReference<Boolean> paired = new AtomicReference<>(false);
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> paired.set(NativeConnection.get(activity).authenticated && !NativeConnection.get(activity).pairingActive()));
                    if (paired.get()) { completed = true; break; }
                    Thread.sleep(100);
                }
                if (!completed) throw new IllegalStateException("Desktop confirmation not completed within 120 seconds");
            } else if ("relay".equals(action)) {
                android.content.SharedPreferences prefs=activity.getSharedPreferences("native-device",0);
                org.json.JSONObject before=new org.json.JSONObject(prefs.getString("binding",""));before.remove("relayOrigin");
                clickLabel("设置");clickLabel("连接管理");clickLabel("连接地址");
                withView(v->v instanceof EditText && "https://你的固定域名".contentEquals(((EditText)v).getHint()),v->((EditText)v).setText(value));
                clickLabel("保存并重连");
                NativeConnection connection=NativeConnection.get(activity);
                for(int i=0;i<600&&!connection.authenticated;i++)Thread.sleep(100);
                if(!connection.authenticated||connection.pairingActive())throw new AssertionError("Fixed origin authentication failed");
                org.json.JSONObject after=new org.json.JSONObject(prefs.getString("binding",""));after.remove("relayOrigin");
                org.junit.Assert.assertEquals(before.toString(),after.toString());
            } else if ("search".equals(action)) {
                withView(v -> v instanceof EditText && "搜索任务".contentEquals(((EditText)v).getHint()),v->((EditText)v).setText(value));Thread.sleep(3000);
                withView(v -> v instanceof android.widget.TextView && "全屏 UI 验收 · 分叉".contentEquals(((android.widget.TextView)v).getText()),v->{});
            } else if ("new".equals(action)) {
                org.json.JSONObject form=new org.json.JSONObject(value);
                withView(v -> "新建会话".equals(String.valueOf(v.getContentDescription())),v->v.performClick());
                withView(v -> v instanceof EditText && "使用电脑默认工作目录".contentEquals(((EditText)v).getHint()),v->((EditText)v).setText(form.optString("cwd")));
                withView(v -> v instanceof EditText && "描述你的任务，或留空创建会话".contentEquals(((EditText)v).getHint()),v->((EditText)v).setText(form.optString("text")));
                clickLabel("模型与推理强度");clickLabel("GPT-6.1-Sol");clickLabel("high");clickLabel("应用设置");
                Thread.sleep(800);clickLabel("开始会话");Thread.sleep(6000);
            } else if ("fork".equals(action)) {
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.onNewIntent(new android.content.Intent().setAction("com.codexpane.OPEN_CHAT")));
                Thread.sleep(1500);
                withView(v -> "会话操作".equals(String.valueOf(v.getContentDescription())),v->v.performClick());
                clickLabel("分叉当前会话");
                withView(v -> v instanceof EditText && "新会话名称".contentEquals(((EditText)v).getHint()),v->((EditText)v).setText(value));
                clickLabel("创建分叉");Thread.sleep(4000);
            } else {
                boolean connected = false;
                for (int i = 0; i < 300; i++) {
                    AtomicReference<Boolean> ready = new AtomicReference<>(false);
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                        NativeConnection connection = NativeConnection.get(activity);
                        ready.set(connection.authenticated && !connection.snapshot.isNull("activeThreadId") && !connection.snapshot.optString("activeThreadId").isEmpty());
                    });
                    if (ready.get()) { connected = true; break; }
                    Thread.sleep(100);
                }
                if (!connected) throw new IllegalStateException("Connection not ready");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.onNewIntent(new android.content.Intent().setAction("com.codexpane.OPEN_CHAT")));
                typeInto(false, value);
                withView(v -> "发送消息".equals(String.valueOf(v.getContentDescription())) && v.isEnabled(), v -> v.performClick());
                Thread.sleep(2000);
            }
            // Leave the ordinary UI visible for the human to verify the result and desktop confirmation code.
        } catch (Throwable ignored) {
            // Espresso's default failure dump can include a pairing URL. Never emit it to instrumentation logs.
            throw new AssertionError("Native UI input failed at "+phase+"; input contents omitted.");
        }
    }
}

