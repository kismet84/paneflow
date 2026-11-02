package com.codexpane.companion;

import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeChatPresentationTest {
    @org.junit.ClassRule public static NativeTestCpuRule cpu = new NativeTestCpuRule();
    private JSONObject item(String id,String kind,String status){return NativeConnection.obj("id",id,"kind",kind,"status",status);}
    @Test public void foldsOnlyCompletedActivitiesAndNeverApprovalsOrFailures(){
        JSONArray input=new JSONArray().put(item("a","activity","completed")).put(item("b","activity","completed")).put(item("c","activity","failed")).put(item("d","approval","completed")).put(item("e","activity","running"));
        JSONArray shown=NativeChatPresentation.project(input,new JSONObject());assertEquals(4,shown.length());assertEquals("fold",shown.optJSONObject(0).optString("kind"));assertEquals("c",shown.optJSONObject(1).optString("id"));assertEquals("d",shown.optJSONObject(2).optString("id"));assertEquals("e",shown.optJSONObject(3).optString("id"));assertEquals(5,input.length());
    }
    @Test public void expandingRestoresAllOriginalActivityIds(){
        JSONArray input=new JSONArray().put(item("a","activity","completed")).put(item("b","activity","completed"));JSONArray shown=NativeChatPresentation.project(input,NativeConnection.obj("activities:a",true));assertEquals(3,shown.length());assertEquals("a",shown.optJSONObject(1).optString("id"));assertEquals("b",shown.optJSONObject(2).optString("id"));
    }
    @Test public void historyFoldingRetainsRoundBoundaryAndCanRestoreSource(){
        JSONArray input=new JSONArray();for(int i=0;i<60;i++)input.put(item("m"+i,i%2==0?"user":"agent","completed"));JSONArray folded=NativeChatPresentation.project(input,new JSONObject());assertEquals(21,folded.length());assertEquals(40,folded.optJSONObject(0).optInt("count"));assertEquals("m40",folded.optJSONObject(1).optString("id"));assertEquals(input.toString(),NativeChatPresentation.project(input,NativeConnection.obj("history",true)).toString());
    }
}
