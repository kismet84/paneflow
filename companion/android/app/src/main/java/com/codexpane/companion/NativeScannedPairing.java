package com.codexpane.companion;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Scanning only produces validated input; it never pairs, browses or executes it. */
final class NativeScannedPairing {
    static String validate(String input)throws Exception {
        if(input==null||input.length()>20000)throw new IllegalArgumentException("二维码内容无效");String value=input.trim();ConnectionUrl.validate(value);URI uri=new URI(value);String fragment=uri.getRawFragment();if(fragment==null||!fragment.startsWith("pair=")||!fragment.substring(5).matches("[A-Za-z0-9_-]+={0,2}"))throw new IllegalArgumentException("请扫描电脑显示的 PaneFlow 配对二维码");
        JSONObject payload=new JSONObject(new String(NativeCrypto.unb64(fragment.substring(5)),StandardCharsets.UTF_8));String origin=new URI(uri.getScheme(),null,uri.getHost(),uri.getPort(),uri.getPath(),null,null).toString().replaceAll("/+$","");
        if(payload.optInt("version")!=1||!origin.equals(payload.optString("relayOrigin"))||payload.optLong("expiresAt")<System.currentTimeMillis())throw new IllegalArgumentException("配对二维码过期或地址不匹配，请在电脑重新生成");return value;
    }
}
