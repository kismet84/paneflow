package com.codexpane.companion;

import org.json.*;
import java.util.*;

/** Whitelisted template fields cannot carry approval policy or permanent permission. */
final class NativeTaskTemplates {
    static JSONArray list(NativeLocalStore local){JSONArray result=new JSONArray();JSONObject saved=local.section("taskTemplates");for(Iterator<String> it=saved.keys();it.hasNext();){JSONObject template=saved.optJSONObject(it.next());if(template!=null)result.put(template);}return result;}
    static String save(NativeLocalStore local,JSONObject input)throws Exception {
        String name=input.optString("name").trim(),cwd=input.optString("cwd").trim(),text=input.optString("text"),model=input.optString("model"),effort=input.optString("effort");
        if(name.isEmpty()||name.length()>80||cwd.length()>4096||text.length()>20000||model.length()>200||effort.length()>50)throw new IllegalArgumentException("模板名称或内容长度无效");
        String id=input.optString("id",UUID.randomUUID().toString());UUID.fromString(id);JSONObject all=new JSONObject(local.section("taskTemplates").toString());if(!all.has(id)&&all.length()>=100)throw new IllegalArgumentException("最多保存 100 个模板");
        all.put(id,NativeConnection.obj("id",id,"name",name,"cwd",cwd,"text",text,"model",model,"effort",effort,"updatedAt",System.currentTimeMillis()));local.save("taskTemplates",all);return id;
    }
    static void remove(NativeLocalStore local,String id)throws Exception {JSONObject all=new JSONObject(local.section("taskTemplates").toString());all.remove(id);local.save("taskTemplates",all);}
}
