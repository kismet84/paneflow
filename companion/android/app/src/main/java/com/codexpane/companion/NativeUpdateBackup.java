package com.codexpane.companion;

import android.content.Context;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;

/** App-private recovery materials. Android Keystore private keys never leave the keystore. */
final class NativeUpdateBackup {
    static File create(Context context,String version)throws Exception {
        File parent=new File(context.getNoBackupFilesDir(),"update-backups");if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("无法创建备份目录");
        File destination=new File(parent,System.currentTimeMillis()+"-"+UUID.randomUUID());if(!destination.mkdir())throw new IOException("无法创建本次备份");JSONArray files=new JSONArray();
        File[] states=context.getNoBackupFilesDir().listFiles();if(states!=null)for(File source:states)if(source.isFile()&&source.getName().matches("pane-state-[A-Za-z0-9-]+\\.enc(?:\\.bak)?"))copy(source,new File(destination,source.getName()),files);
        File prefs=new File(context.getApplicationInfo().dataDir,"shared_prefs");File[] preferences=prefs.listFiles();if(preferences!=null)for(File source:preferences)if(source.isFile()&&source.getName().matches("(?:native-device(?:-[A-Za-z0-9-]+)?|pane-computers|native-notifications)\\.xml"))copy(source,new File(destination,source.getName()),files);
        JSONObject manifest=NativeConnection.obj("schemaVersion",1,"createdAt",System.currentTimeMillis(),"targetVersion",version,"containsPrivateKeys",false,"recovery","App-private encrypted data and identity references. Keep installed Android Keystore keys; do not uninstall.","files",files);
        File manifestFile=new File(destination,"backup.json");try(FileOutputStream output=new FileOutputStream(manifestFile)){output.write(manifest.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));output.getFD().sync();}return destination;
    }
    private static void copy(File source,File destination,JSONArray files)throws Exception {if(Files.isSymbolicLink(source.toPath()))throw new SecurityException("备份源不能是符号链接");long total=0;try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(destination)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){total+=n;if(total>64L*1024*1024)throw new IOException("本机单文件备份超过限制");out.write(buffer,0,n);}out.getFD().sync();}files.put(NativeConnection.obj("name",source.getName(),"size",destination.length(),"sha256",NativeUpdateVerifier.sha256(destination)));}
}
