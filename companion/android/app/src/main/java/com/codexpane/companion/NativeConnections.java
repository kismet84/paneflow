package com.codexpane.companion;

import android.content.*;
import java.util.*;
import org.json.*;

/** Each profile owns its connection, identity and encrypted conversation data. */
final class NativeConnections {
    private static NativeConnections instance;
    static synchronized NativeConnections get(Context context){if(instance==null)instance=new NativeConnections(context.getApplicationContext());return instance;}
    private final Context context;
    private final SharedPreferences preferences;
    private final LinkedHashMap<String,NativeConnection> computers=new LinkedHashMap<>();
    private String selected;
    private boolean foreground;
    private NativeConnections(Context context){
        this.context=context;preferences=context.getSharedPreferences("pane-computers",Context.MODE_PRIVATE);
        String raw=preferences.getString("profiles","");
        try {if(!raw.isEmpty()){JSONArray ids=new JSONArray(raw);for(int i=0;i<ids.length();i++){String id=ids.getString(i);if(id.matches("[a-zA-Z0-9-]{1,64}"))computers.put(id,new NativeConnection(context,id));}}}
        catch(Exception e){throw new IllegalStateException("电脑列表无法读取，原配置已保留",e);}
        // Legacy preferences remain in place, including the exact identity and background opt-in.
        if(computers.isEmpty())computers.put("legacy",new NativeConnection(context,"legacy"));
        selected=preferences.getString("selected","legacy");if(!computers.containsKey(selected))selected=computers.keySet().iterator().next();save();
    }
    private void save(){JSONArray ids=new JSONArray();for(String id:computers.keySet())ids.put(id);if(!preferences.edit().putString("profiles",ids.toString()).putString("selected",selected).commit())throw new IllegalStateException("无法保存电脑列表");}
    NativeConnection active(){return computers.get(selected);}
    NativeConnection find(String id){return computers.get(id);}
    List<NativeConnection> all(){return new ArrayList<>(computers.values());}
    NativeConnection select(String id){if(!computers.containsKey(id))throw new IllegalArgumentException("电脑不存在");selected=id;save();return active();}
    NativeConnection add(){String id=UUID.randomUUID().toString();NativeConnection c=new NativeConnection(context,id);computers.put(id,c);String old=selected;selected=id;try{save();}catch(RuntimeException e){computers.remove(id);selected=old;throw e;}c.visible=foreground;return c;}
    void remove(String id)throws Exception {NativeConnection c=computers.get(id);if(c==null)return;c.forget();c.dispose();computers.remove(id);if(computers.isEmpty())computers.put("legacy",new NativeConnection(context,"legacy"));if(!computers.containsKey(selected))selected=computers.keySet().iterator().next();save();}
    void foreground(boolean value){foreground=value;for(NativeConnection c:all()){c.visible=value;if(value||c.background())c.resume();else c.disconnect();}}
    boolean anyBackground(){for(NativeConnection c:all())if(c.paired()&&c.background())return true;return false;}
    void resumeBackground(){for(NativeConnection c:all())if(c.background()&&c.paired())c.resume();}
    void stopBackground(){for(NativeConnection c:all()){c.background(false);if(!c.visible)c.disconnect();}}
}
