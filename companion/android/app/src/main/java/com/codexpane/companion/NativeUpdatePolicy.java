package com.codexpane.companion;

import java.net.URI;

final class NativeUpdatePolicy {
    static final String MANIFEST_URL="https://github.com/kismet84/paneflow/releases/latest/download/update.json";
    static final String PACKAGE="com.codexpane.companion";
    static final long MAX_APK_BYTES=250L*1024*1024;
    private static boolean base(URI uri){return "https".equalsIgnoreCase(uri.getScheme())&&uri.getHost()!=null&&uri.getRawUserInfo()==null&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getRawFragment()==null;}
    static boolean repositoryAsset(String value){try{URI uri=new URI(value);return base(uri)&&"github.com".equalsIgnoreCase(uri.getHost())&&uri.getRawQuery()==null&&uri.getRawPath().matches("/kismet84/paneflow/releases/download/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*");}catch(Exception e){return false;}}
    static boolean androidAsset(String value){return repositoryAsset(value)&&value.toLowerCase(java.util.Locale.ROOT).endsWith(".apk");}
    static boolean fetchUrl(String value){if(MANIFEST_URL.equals(value)||repositoryAsset(value))return true;try{URI uri=new URI(value);return base(uri)&&("release-assets.githubusercontent.com".equalsIgnoreCase(uri.getHost())||"objects.githubusercontent.com".equalsIgnoreCase(uri.getHost()))&&uri.getRawPath().startsWith("/github-production-release-asset");}catch(Exception e){return false;}}
}
