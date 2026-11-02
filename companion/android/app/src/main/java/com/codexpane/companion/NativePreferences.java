package com.codexpane.companion;
import android.content.Context;
final class NativePreferences {
    static boolean completion(Context c){return c.getSharedPreferences("native-notifications",0).getBoolean("completion",true);}
    static void completion(Context c,boolean on){c.getSharedPreferences("native-notifications",0).edit().putBoolean("completion",on).apply();}
    static boolean approvals(Context c){return c.getSharedPreferences("native-notifications",0).getBoolean("approvals",true);}
    static void approvals(Context c,boolean on){c.getSharedPreferences("native-notifications",0).edit().putBoolean("approvals",on).apply();}
}
