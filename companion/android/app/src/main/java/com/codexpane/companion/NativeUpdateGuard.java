package com.codexpane.companion;

import org.json.*;
import java.util.*;

/** Fail closed when a paired computer is offline, stale or lacks queue visibility. */
final class NativeUpdateGuard {
    static String check(List<NativeConnection> computers,long now){for(NativeConnection computer:computers){if(!computer.paired())continue;String reason=checkState(computer.authenticated,computer.lastSnapshotAt,computer.snapshot,now);if(!reason.isEmpty())return computer.name()+"："+reason;if(!computer.local.failure().isEmpty())return computer.name()+"：本机数据无法读取，不能升级";JSONArray records=computer.requests(null);for(int i=0;i<records.length();i++){JSONObject record=records.optJSONObject(i);if(record!=null&&!Arrays.asList("completed","failed").contains(record.optString("status")))return computer.name()+"：仍有未核对操作回执";}}return "";}
    static String checkState(boolean authenticated,long receivedAt,JSONObject snapshot,long now){
        if(!authenticated||!snapshot.optBoolean("deviceOnline",false))return "电脑离线，无法确认任务安全状态";
        if(receivedAt<=0||now-receivedAt>15000||receivedAt>now+1000)return "任务快照过期，请重新检查";
        if(!"ready".equals(snapshot.optString("codexState")))return "电脑执行服务尚未就绪";
        String active=snapshot.isNull("activeTurnId")?"":snapshot.optString("activeTurnId");if(!active.isEmpty()||!Arrays.asList("idle","failed").contains(snapshot.optString("turnStatus")))return "仍有执行或待审批轮次";
        JSONArray threads=snapshot.optJSONArray("threads");if(threads==null)return "缺少会话状态";for(int i=0;i<threads.length();i++){JSONObject thread=threads.optJSONObject(i);if(thread==null||!Arrays.asList("idle","failed").contains(thread.optString("status")))return "还有运行中或未知状态的会话";}
        JSONObject queue=snapshot.optJSONObject("queue");if(queue==null||queue.optJSONArray("tasks")==null)return "电脑版本不支持完整队列核对，请先升级电脑端";
        String activeTask=queue.isNull("activeTaskId")?"":queue.optString("activeTaskId");if(!activeTask.isEmpty())return "队列执行槽仍被占用";
        JSONArray tasks=queue.optJSONArray("tasks");for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task==null||!Arrays.asList("completed","failed","cancelled").contains(task.optString("queueState")))return "队列仍有待执行、运行或结果不明的任务";}
        JSONArray approvals=snapshot.optJSONArray("approvals");if(approvals==null)return "缺少审批状态";if(approvals.length()>0)return "仍有待审批操作";return "";
    }
}
