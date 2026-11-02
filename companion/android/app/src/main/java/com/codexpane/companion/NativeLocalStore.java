package com.codexpane.companion;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** Authenticated, atomic storage. Failed decrypts never overwrite the recoverable original. */
final class NativeLocalStore {
    private final AtomicFile file;
    private JSONObject data;
    private String failure="";
    NativeLocalStore(Context context,String id) {
        file=new AtomicFile(new File(context.getNoBackupFilesDir(),"pane-state-"+id+".enc"));
        try { data=read(); } catch(Exception e) { data=new JSONObject();failure="本机加密数据无法读取；原文件已保留，请勿继续发送"; }
    }
    private javax.crypto.SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        String alias="paneflow-local-data-v1";
        if(!store.containsAlias(alias)) {
            if(exists())throw new SecurityException("Missing local encryption key");
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
        }
        return (javax.crypto.SecretKey)store.getKey(alias,null);
    }
    private boolean exists(){return file.getBaseFile().exists()||new File(file.getBaseFile().getPath()+".bak").exists();}
    private JSONObject read() throws Exception {
        if(!exists())return new JSONObject();
        byte[] bytes=file.readFully();if(bytes.length<29||bytes[0]!=1)throw new SecurityException("Invalid local format");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,bytes,1,12));
        return new JSONObject(new String(cipher.doFinal(bytes,13,bytes.length-13),StandardCharsets.UTF_8));
    }
    synchronized JSONObject section(String name) {JSONObject value=data.optJSONObject(name);return value==null?new JSONObject():value;}
    synchronized String text(String section,String name){return section(section).optString(name,"");}
    synchronized String failure(){return failure;}
    synchronized void save(String section,JSONObject value) throws Exception {
        if(!failure.isEmpty())throw new IllegalStateException(failure);
        JSONObject updated=new JSONObject(data.toString());updated.put(section,value);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] encrypted=cipher.doFinal(updated.toString().getBytes(StandardCharsets.UTF_8));
        FileOutputStream output=null;
        try {output=file.startWrite();output.write(1);output.write(cipher.getIV());output.write(encrypted);file.finishWrite(output);data=updated;}
        catch(Exception e){if(output!=null)file.failWrite(output);throw e;}
    }
    synchronized void text(String section,String name,String value) throws Exception {JSONObject updated=new JSONObject(section(section).toString());updated.put(name,value);save(section,updated);}
    void clear(){file.delete();data=new JSONObject();failure="";}
}
