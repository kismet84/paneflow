package com.codexpane.companion;

import org.json.*;

/** UI-only folding. Source history and server context are never modified. */
final class NativeChatPresentation {
    static JSONArray project(JSONArray source,JSONObject expanded) {
        JSONArray result=new JSONArray();int start=0;
        if(source.length()>30&&!expanded.optBoolean("history")) {
            start=source.length()-20;
            // Keep an entire user round when a suitable boundary is available.
            while(start>0&&!"user".equals(source.optJSONObject(start).optString("kind")))start--;
            if(start>0)result.put(NativeConnection.obj("id","fold:history","kind","fold","key","history","title","展开 "+start+" 条较早消息","count",start));
        }
        for(int i=start;i<source.length();) {
            JSONObject item=source.optJSONObject(i);if(item==null){i++;continue;}
            if(completedActivity(item)) {
                int end=i+1;while(end<source.length()&&completedActivity(source.optJSONObject(end)))end++;
                String key="activities:"+item.optString("id");
                if(end-i>1) {
                    result.put(NativeConnection.obj("id","fold:"+key,"kind","fold","key",key,"title",(expanded.optBoolean(key)?"收起":"展开")+" "+(end-i)+" 项已完成操作","count",end-i));
                    if(!expanded.optBoolean(key)){i=end;continue;}
                    while(i<end)result.put(source.optJSONObject(i++));continue;
                }
            }
            result.put(item);i++;
        }
        return result;
    }
    private static boolean completedActivity(JSONObject item){return item!=null&&"activity".equals(item.optString("kind"))&&"completed".equals(item.optString("status"));}
}
