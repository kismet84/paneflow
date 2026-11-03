package com.codexpane.companion;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import org.json.*;
import java.util.*;

/** A single foreground service keeps only explicitly opted-in computer connections alive. */
public class NativeMessagingService extends Service implements NativeConnection.Listener {
    private static final String CHANNEL="pane_connection",ALERTS="pane_alerts";
    private NativeConnections computers;
    private final Set<NativeConnection> listening=new HashSet<>();
    private final Map<String,String> states=new HashMap<>();
    private final Set<String> approvals=new HashSet<>();
    private final Map<String,String> queueStates=new HashMap<>();
    private final Map<String,Long> lastAlerts=new HashMap<>();
    static void enable(Context context){NativeConnection.get(context).background(true);ensure(context);}
    static void ensure(Context context){Intent intent=new Intent(context,NativeMessagingService.class);if(Build.VERSION.SDK_INT>=26)context.startForegroundService(intent);else context.startService(intent);}
    static void disable(Context context){NativeConnection active=NativeConnection.get(context);active.background(false);if(!active.visible)active.disconnect();if(NativeConnections.get(context).anyBackground())ensure(context);else context.stopService(new Intent(context,NativeMessagingService.class));}
    private Notification.Builder notification(String channel,String title,String text,NativeConnection computer,String thread){
        Intent open=new Intent(this,NativeChatActivity.class).setAction("com.codexpane.OPEN_CHAT");
        String target=computer==null?"":computer.computerId;if(computer!=null)open.putExtra("computerId",target).putExtra("threadId",thread).putExtra("consoleRoute","有任务等待确认".equals(title)?"approvals":thread.isEmpty()?"queue":"chat");
        open.setData(android.net.Uri.parse("paneflow://notification/"+target+"/"+thread));
        PendingIntent content=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,channel).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(text).setContentIntent(content).setVisibility(Notification.VISIBILITY_PRIVATE).setShowWhen(false);
    }
    private Notification ongoing(){PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,NativeMessagingService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);return notification(CHANNEL,"PaneFlow · 后台连接","仅保持已开启后台连接的电脑",null,"").setOngoing(true).addAction(new Notification.Action.Builder(null,"停止所有后台连接",stop).build()).build();}
    @Override public void onCreate(){super.onCreate();computers=NativeConnections.get(this);NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel(CHANNEL,"后台连接",NotificationManager.IMPORTANCE_LOW));NotificationChannel alerts=new NotificationChannel(ALERTS,"任务完成与待处理",NotificationManager.IMPORTANCE_DEFAULT);alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);manager.createNotificationChannel(alerts);if(Build.VERSION.SDK_INT>=34)startForeground(100,ongoing(),ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);else startForeground(100,ongoing());refreshListeners();}
    private void refreshListeners(){for(NativeConnection c:computers.all())if(c.background()&&listening.add(c)){c.add(this);seed(c,false);}for(NativeConnection c:new ArrayList<>(listening))if(!c.background()){c.remove(this);listening.remove(c);}}
    @Override public int onStartCommand(Intent intent,int flags,int startId){if(intent!=null&&"stop".equals(intent.getAction()))computers.stopBackground();if(!computers.anyBackground()){stopSelf();return START_NOT_STICKY;}refreshListeners();computers.resumeBackground();return START_STICKY;}
    @Override public void changed(JSONObject event){NativeConnection c=computers.find(event.optString("computerId"));if(c==null||!c.background())return;String type=event.optString("type");if("snapshot".equals(type))seed(c,true);if("approval.request".equals(type)){JSONObject item=event.optJSONObject("approval");if(item!=null&&approvals.add(c.computerId+":"+item.optString("id")+":"+item.optInt("version")))alert(c,event.optString("threadId"),"有任务等待确认","请打开应用核对任务后处理");}if("turn.status".equals(type))update(c,event.optString("threadId"),event.optString("status"),true);if(states.size()>2000)states.clear();if(approvals.size()>2000)approvals.clear();}
    private void update(NativeConnection c,String id,String current,boolean notify){String previous=states.put(c.computerId+":"+id,current);if(!notify)return;if(!"failed".equals(previous)&&"failed".equals(current))alert(c,id,"任务需要检查","打开应用查看任务状态");}
    private void seed(NativeConnection c,boolean notify){JSONArray center=c.snapshot.optJSONArray("approvals");if(center!=null)for(int i=0;i<center.length();i++){JSONObject wrapper=center.optJSONObject(i),item=wrapper==null?null:wrapper.optJSONObject("approval");if(item!=null&&approvals.add(c.computerId+":"+item.optString("id")+":"+item.optInt("version"))&&notify)alert(c,wrapper.optString("threadId"),"有任务等待确认","请打开审批中心逐项核对");}
        JSONObject queue=c.snapshot.optJSONObject("queue");JSONArray queued=queue==null?null:queue.optJSONArray("tasks");if(queued!=null)for(int i=0;i<queued.length();i++){JSONObject task=queued.optJSONObject(i);if(task==null)continue;String key=c.computerId+":"+task.optString("id"),state=task.optString("queueState"),before=queueStates.put(key,state);if(notify&&!state.equals(before)){if("unknown".equals(state))alert(c,"","任务需要检查","队列结果不明，请人工核对");else if("failed".equals(state))alert(c,task.optString("threadId"),"任务需要检查","排队任务失败");}}if(queueStates.size()>2000)queueStates.clear();
        JSONArray threads=c.snapshot.optJSONArray("threads");if(threads!=null)for(int i=0;i<threads.length();i++){JSONObject thread=threads.optJSONObject(i);if(thread!=null){update(c,thread.optString("id"),thread.optString("status"),notify);if(notify)goalCompletion(c,thread);}}String active=c.snapshot.optString("activeThreadId","");if(!active.isEmpty()&&!"null".equals(active))update(c,active,c.snapshot.optString("turnStatus"),notify);JSONArray items=c.snapshot.optJSONArray("items");if(items!=null)for(int i=0;i<items.length();i++){JSONObject item=items.optJSONObject(i);if(item!=null&&"approval".equals(item.optString("kind"))&&approvals.add(c.computerId+":"+item.optString("id")+":"+item.optInt("version"))&&notify)alert(c,active,"有任务等待确认","请打开应用核对任务后处理");}}
    private void goalCompletion(NativeConnection c,JSONObject thread){
        String id=thread.optString("id"),current=thread.optString("goalStatus");
        if(id.isEmpty()||!thread.optBoolean("goalStateKnown")||!NativeTaskCompletion.known(current))return;
        String previous=c.local.text("completionGoals",id);
        if(current.equals(previous))return;
        boolean completed=NativeTaskCompletion.completed(previous,current);
        // Commit before notifying: replayed snapshots and service restarts must not ring again.
        // A storage failure suppresses the notification rather than risking repeated alerts.
        try{c.local.text("completionGoals",id,current);}catch(Exception error){return;}
        if(completed)alert(c,id,"任务已完成","任务目标已完成，打开应用查看结果");
    }
    private void alert(NativeConnection c,String thread,String title,String message){if(c.visible||!c.background())return;String alertKey=c.computerId+":"+thread+":"+title;long now=System.currentTimeMillis();Long previous=lastAlerts.put(alertKey,now);if(previous!=null&&now-previous<2000)return;if(lastAlerts.size()>2000)lastAlerts.clear();if("任务已完成".equals(title)&&!NativePreferences.completion(this))return;if("有任务等待确认".equals(title)&&!NativePreferences.approvals(this))return;try{getSystemService(NotificationManager.class).notify((c.computerId+":"+thread).hashCode(),notification(ALERTS,title,c.name()+" · "+message,c,thread).setAutoCancel(true).build());}catch(SecurityException ignored){}}
    @Override public void onDestroy(){for(NativeConnection c:listening){c.remove(this);if(!c.visible)c.disconnect();}listening.clear();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
