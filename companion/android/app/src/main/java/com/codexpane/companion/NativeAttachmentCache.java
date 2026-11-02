package com.codexpane.companion;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.security.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.util.UUID;

/** Private encrypted media only. Plain files exist solely for explicit camera/export handoff. */
final class NativeAttachmentCache {
    static final int MAX_BYTES=20*1024*1024;
    private final File directory;
    NativeAttachmentCache(Context context){directory=new File(context.getNoBackupFilesDir(),"attachment-cache");if(!directory.exists()&&!directory.mkdirs())throw new IllegalStateException("附件缓存无法创建");}
    private File file(String id){UUID.fromString(id);return new File(directory,id+".enc");}
    private javax.crypto.SecretKey key(boolean existing)throws Exception{
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);String alias="paneflow-attachment-cache-v1";
        if(!keys.containsAlias(alias)){File[] saved=directory.listFiles();if(existing||(saved!=null&&saved.length>0))throw new SecurityException("附件加密密钥不可用");KeyGenerator generator=KeyGenerator.getInstance("AES","AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}
        return (javax.crypto.SecretKey)keys.getKey(alias,null);
    }
    synchronized void save(String id,byte[] bytes)throws Exception{
        if(bytes.length==0||bytes.length>MAX_BYTES)throw new IOException("附件大小须为 1 字节至 20 MiB");
        long used=0;File[] files=directory.listFiles();if(files!=null)for(File f:files)used+=f.length();File target=file(id);if(used-target.length()+bytes.length>100L*1024*1024)throw new IOException("附件缓存已达 100 MiB，请移除不再需要的草稿附件");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(target.exists()));AtomicFile atomic=new AtomicFile(target);FileOutputStream out=null;
        try{out=atomic.startWrite();out.write(1);out.write(cipher.getIV());out.write(cipher.doFinal(bytes));atomic.finishWrite(out);}catch(Exception e){if(out!=null)atomic.failWrite(out);throw e;}
    }
    synchronized byte[] read(String id)throws Exception{
        File target=file(id);if(!target.exists()||target.length()>MAX_BYTES+64)throw new IOException("本机附件缓存不可用");byte[] encrypted=new AtomicFile(target).readFully();if(encrypted.length<29||encrypted[0]!=1)throw new IOException("附件缓存格式无效");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(true),new GCMParameterSpec(128,encrypted,1,12));return cipher.doFinal(encrypted,13,encrypted.length-13);
    }
    synchronized void remove(String id){new AtomicFile(file(id)).delete();}
    synchronized boolean exists(String id){try{return file(id).exists();}catch(IllegalArgumentException e){return false;}}
    static String hash(byte[] bytes)throws Exception{StringBuilder hex=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return hex.toString();}
    static byte[] bounded(InputStream input)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] block=new byte[16384];int count;while((count=input.read(block))!=-1){if(out.size()+count>MAX_BYTES)throw new IOException("附件超过 20 MiB");out.write(block,0,count);}if(out.size()==0)throw new IOException("不能上传空文件");return out.toByteArray();}
}
