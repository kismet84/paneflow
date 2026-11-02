package com.codexpane.companion;

import org.json.*;
import java.util.*;

/** Presentation model keeps goal, runtime and queue states distinct. */
final class NativeTaskCatalog {
    static final class Row {
        final NativeConnection computer;
        final String taskId,threadId,title,cwd,goal,runtime,queue;
        final long updatedAt;
        Row(NativeConnection computer,JSONObject thread,JSONObject task){
            this.computer=computer;taskId=text(task,"id");threadId=task==null?text(thread,"id"):text(task,"threadId");
            title=task!=null?task.optString("title",text(thread,"title")):text(thread,"title");cwd=task!=null?text(task,"cwd"):text(thread,"cwd");
            goal=text(thread,"goalStatus");runtime=thread==null?runtimeForQueue(text(task,"queueState")):text(thread,"status");queue=text(task,"queueState");
            updatedAt=Math.max(milliseconds(thread==null?0:thread.optLong("updatedAt")),milliseconds(task==null?0:task.optLong("updatedAt")));
        }
        String identity(){return computer.computerId+":"+(!taskId.isEmpty()?"queue:"+taskId:"thread:"+threadId);}
    }
    static long milliseconds(long timestamp){return timestamp>0&&timestamp<100000000000L?timestamp*1000:timestamp;}
    static String text(JSONObject value,String key){return value==null||value.isNull(key)?"":value.optString(key,"");}
    private static String runtimeForQueue(String state){return Arrays.asList("running","waiting","failed").contains(state)?state:Arrays.asList("pending","completed","cancelled").contains(state)?"idle":"unknown";}
    static List<Row> rows(List<NativeConnection> computers){
        List<Row> result=new ArrayList<>();
        for(NativeConnection computer:computers){Map<String,JSONObject> threads=new LinkedHashMap<>();JSONArray summaries=computer.snapshot.optJSONArray("threads");if(summaries!=null)for(int i=0;i<summaries.length();i++){JSONObject value=summaries.optJSONObject(i);if(value!=null)threads.put(value.optString("id"),value);}
            Set<String> queuedThreads=new HashSet<>();JSONObject queue=computer.snapshot.optJSONObject("queue");JSONArray tasks=queue==null?null:queue.optJSONArray("tasks");
            if(tasks!=null)for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task==null)continue;String id=text(task,"threadId");if(!id.isEmpty())queuedThreads.add(id);result.add(new Row(computer,threads.get(id),task));}
            for(JSONObject thread:threads.values())if(!queuedThreads.contains(thread.optString("id")))result.add(new Row(computer,thread,null));
        }
        result.sort((a,b)->Long.compare(b.updatedAt,a.updatedAt));return result;
    }
    static List<Row> filter(List<Row> rows,String computer,String project,String state,String query){List<Row> found=new ArrayList<>();String term=query.toLowerCase(Locale.ROOT);for(Row row:rows){if(!computer.isEmpty()&&!computer.equals(row.computer.computerId))continue;if(!project.isEmpty()&&!project.equals(row.cwd.isEmpty()?"(unknown)":row.cwd))continue;if(!(row.title+" "+row.cwd+" "+row.computer.name()).toLowerCase(Locale.ROOT).contains(term))continue;
            boolean active=Arrays.asList("pending","dispatching","running","waiting","unknown").contains(row.queue)||Arrays.asList("running","waiting","failed").contains(row.runtime)||(!row.goal.isEmpty()&&!"complete".equals(row.goal));
            if("unfinished".equals(state)&&!active)continue;if("running".equals(state)&&!"running".equals(row.runtime))continue;if("waiting".equals(state)&&!"waiting".equals(row.runtime))continue;if("pending".equals(state)&&!"pending".equals(row.queue))continue;if("unknown".equals(state)&&!"unknown".equals(row.queue))continue;if("failed".equals(state)&&!"failed".equals(row.runtime)&&!"failed".equals(row.queue))continue;if("complete".equals(state)&&!"complete".equals(row.goal)&&!"completed".equals(row.queue))continue;found.add(row);
        }return found;}
    static boolean approvalCurrent(NativeConnection computer,JSONObject expected){JSONArray approvals=computer.snapshot.optJSONArray("approvals");JSONObject expectedItem=expected.optJSONObject("approval");if(expectedItem==null||approvals==null)return false;for(int i=0;i<approvals.length();i++){JSONObject current=approvals.optJSONObject(i),item=current==null?null:current.optJSONObject("approval");if(item!=null&&text(expected,"threadId").equals(text(current,"threadId"))&&expectedItem.optString("id").equals(item.optString("id"))&&expectedItem.optInt("version")==item.optInt("version"))return true;}return false;}
}
