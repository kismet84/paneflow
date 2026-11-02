package com.codexpane.companion;

import org.json.*;
import java.util.Locale;

final class NativeUpdateManifest {
    final String version,notes,url,sha256,packageName;final int minProtocol,maxProtocol;final long size,versionCode;
    NativeUpdateManifest(JSONObject root)throws Exception {
        if(integer(root,"schemaVersion",1,1)!=1)throw new IllegalArgumentException("不支持的更新清单格式");
        version=root.getString("version");notes=root.getString("notes");minProtocol=(int)integer(root,"minProtocol",1,Integer.MAX_VALUE);maxProtocol=(int)integer(root,"maxProtocol",1,Integer.MAX_VALUE);
        if(!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")||notes.length()>40000||minProtocol<1||maxProtocol<minProtocol)throw new IllegalArgumentException("更新版本或兼容信息无效");
        JSONObject android=root.getJSONObject("assets").getJSONObject("android");url=android.getString("url");sha256=android.getString("sha256").toLowerCase(Locale.ROOT);size=integer(android,"size",1,NativeUpdatePolicy.MAX_APK_BYTES);versionCode=integer(android,"versionCode",1,Integer.MAX_VALUE);packageName=android.getString("packageName");
        if(!NativeUpdatePolicy.androidAsset(url)||!sha256.matches("[a-f0-9]{64}")||size<1||size>NativeUpdatePolicy.MAX_APK_BYTES||versionCode<1||!NativeUpdatePolicy.PACKAGE.equals(packageName))throw new IllegalArgumentException("安装包来源或校验信息无效");
    }
    private static long integer(JSONObject object,String field,long min,long max){Object value=object.opt(field);if(!(value instanceof Number))throw new IllegalArgumentException("更新清单数值类型无效");double number=((Number)value).doubleValue();if(!Double.isFinite(number)||number!=Math.floor(number)||number<min||number>max)throw new IllegalArgumentException("更新清单数值范围无效");return ((Number)value).longValue();}
    boolean compatible(){return minProtocol<=1&&maxProtocol>=1;}
}
