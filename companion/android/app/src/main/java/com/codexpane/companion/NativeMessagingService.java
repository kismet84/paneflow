package com.codexpane.companion;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.HashMap;
import java.util.Map;

public class NativeMessagingService extends Service implements NativeConnection.Listener {
    private static final String CHANNEL = "pane_connection", ALERTS = "pane_alerts";
    private NativeConnection connection;
    private final Map<String, String> states = new HashMap<>();
    private final Map<String, Boolean> approvals = new HashMap<>();
    static void enable(Context context) {
        NativeConnection.get(context).background(true);
        Intent intent = new Intent(context, NativeMessagingService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }
    static void disable(Context context) {
        NativeConnection.get(context).background(false);
        context.stopService(new Intent(context, NativeMessagingService.class));
    }
    private Notification.Builder notification(String channel, String title, String text) {
        Intent open = new Intent(this, NativeChatActivity.class).setAction("com.codexpane.OPEN_CHAT");
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(text).setContentIntent(content).setVisibility(Notification.VISIBILITY_PRIVATE).setShowWhen(false);
    }
    private Notification ongoing() {
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, NativeMessagingService.class).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return notification(CHANNEL, "PaneFlow · 后台连接", "后台连接已启用 · 可随时停止").setOngoing(true).addAction(new Notification.Action.Builder(null, "停止后台连接", stop).build()).build();
    }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "后台连接", NotificationManager.IMPORTANCE_LOW));
            NotificationChannel alerts = new NotificationChannel(ALERTS, "任务完成与待处理", NotificationManager.IMPORTANCE_DEFAULT);
            alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE); manager.createNotificationChannel(alerts);
        }
        if (Build.VERSION.SDK_INT >= 34) startForeground(100, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING); else startForeground(100, ongoing());
        connection = NativeConnection.get(this); connection.add(this);
        seedSnapshot(false);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if ((intent != null && "stop".equals(intent.getAction())) || !connection.background()) {
            connection.background(false); stopSelf(); return START_NOT_STICKY;
        }
        connection.resume();
        return START_STICKY;
    }
    @Override public void changed(JSONObject event) {
        String type = event.optString("type");
        if ("snapshot".equals(type)) seedSnapshot(true);
        if ("approval.request".equals(type)) {
            JSONObject item = event.optJSONObject("approval");
            if (item != null && approvals.put(item.optString("id") + ":" + item.optInt("version"), true) == null) alert("有任务等待确认", "请打开应用核对任务后处理");
        }
        if ("turn.status".equals(type)) {
            String current = event.optString("status"), id = event.optString("threadId");
            updateStatus(id, current, true);
        }
        if (states.size() > 500) states.clear();
        if (approvals.size() > 500) approvals.clear();
    }
    private void updateStatus(String id, String current, boolean notify) {
        String previous = states.put(id, current);
        if (!notify) return;
        if (("running".equals(previous) || "waiting".equals(previous)) && "idle".equals(current)) alert("任务已完成", "打开应用查看最新结果");
        else if (!"failed".equals(previous) && "failed".equals(current)) alert("任务需要检查", "打开应用查看任务状态");
    }
    private void seedSnapshot(boolean notify) {
        JSONArray threads = connection.snapshot.optJSONArray("threads");
        if (threads != null) for (int i=0;i<threads.length();i++) {
            JSONObject thread = threads.optJSONObject(i);
            if (thread != null) updateStatus(thread.optString("id"), thread.optString("status"), notify);
        }
        String active = connection.snapshot.optString("activeThreadId", "");
        if (!active.isEmpty() && !"null".equals(active)) updateStatus(active, connection.snapshot.optString("turnStatus"), notify);
        JSONArray items = connection.snapshot.optJSONArray("items");
        if (items != null) for (int i=0;i<items.length();i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && "approval".equals(item.optString("kind")) && approvals.put(item.optString("id") + ":" + item.optInt("version"), true) == null && notify) alert("有任务等待确认", "请打开应用核对任务后处理");
        }
    }
    private void alert(String title, String message) {
        if (connection.visible) return;
        if ("任务已完成".equals(title) && !NativePreferences.completion(this)) return;
        if ("有任务等待确认".equals(title) && !NativePreferences.approvals(this)) return;
        try { getSystemService(NotificationManager.class).notify(101, notification(ALERTS, title, message).setAutoCancel(true).build()); }
        catch (SecurityException ignored) { /* User can deny notification permission without granting more access. */ }
    }
    @Override public void onDestroy() {
        if (connection != null) { connection.remove(this); if (!connection.visible) connection.disconnect(); }
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
