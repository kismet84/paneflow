package com.codexpane.companion;

import android.content.Context;
import android.content.pm.*;
import android.os.Build;
import java.io.*;
import java.security.*;
import java.util.*;

final class NativeUpdateVerifier {
    static String sha256(File file)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=in.read(buffer))!=-1)digest.update(buffer,0,count);}StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();}
    static long versionCode(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}
    static int signatureFlags(){return Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;}
    static Set<String> certificates(PackageInfo info)throws Exception {android.content.pm.Signature[] signatures=Build.VERSION.SDK_INT>=28?(info.signingInfo==null?null:info.signingInfo.getApkContentsSigners()):info.signatures;if(signatures==null||signatures.length==0)throw new SecurityException("无法读取安装证书");Set<String> result=new TreeSet<>();for(android.content.pm.Signature signature:signatures)result.add(Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));return result;}
    static boolean debugCertificate(PackageInfo info){try{android.content.pm.Signature[] signatures=Build.VERSION.SDK_INT>=28?(info.signingInfo==null?null:info.signingInfo.getApkContentsSigners()):info.signatures;if(signatures!=null)for(android.content.pm.Signature signature:signatures){java.security.cert.X509Certificate certificate=(java.security.cert.X509Certificate)java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(signature.toByteArray()));if(certificate.getSubjectX500Principal().getName().toLowerCase(Locale.ROOT).contains("android debug"))return true;}}catch(Exception ignored){}return false;}
    static void verify(Context context,File apk,NativeUpdateManifest manifest)throws Exception {
        if(!manifest.compatible())throw new SecurityException("更新协议与当前客户端不兼容");
        if(!apk.isFile()||apk.length()!=manifest.size||!manifest.sha256.equals(sha256(apk)))throw new SecurityException("安装包大小或 SHA-256 校验失败");
        PackageManager manager=context.getPackageManager();PackageInfo current=manager.getPackageInfo(context.getPackageName(),signatureFlags()),candidate=manager.getPackageArchiveInfo(apk.getAbsolutePath(),signatureFlags());
        if(candidate==null||(candidate.applicationInfo!=null&&candidate.applicationInfo.minSdkVersion>Build.VERSION.SDK_INT)||!context.getPackageName().equals(candidate.packageName)||!manifest.packageName.equals(candidate.packageName)||versionCode(candidate)!=manifest.versionCode||!manifest.version.equals(candidate.versionName)||versionCode(candidate)<=versionCode(current))throw new SecurityException("安装包身份、版本或升级方向不匹配");
        if(!certificates(current).equals(certificates(candidate)))throw new SecurityException("安装证书与当前应用不同，已拒绝覆盖；请勿卸载后强行安装");
    }
}
