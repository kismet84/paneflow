package com.codexpane.companion;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.widget.*;
import android.view.View;
import androidx.core.content.FileProvider;
import org.json.*;
import okhttp3.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Fixed-source updater. Downloads are inert until a fresh idle check, backup and user confirmation. */
final class NativeUpdateController {
    interface Host {Dialog sheet(String title,LinearLayout content);void error(String message);void flushInputs();}
    private final Activity activity;private final PaneUi ui;private final NativeConnections computers;private final Host host;
    private final Handler main=new Handler(Looper.getMainLooper());private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final OkHttpClient client=new OkHttpClient.Builder().dns(new ResilientDns()).followRedirects(false).followSslRedirects(false).connectTimeout(20,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).callTimeout(5,TimeUnit.MINUTES).build();
    private volatile Call call;private boolean busy,closed;private LinearLayout body;private NativeUpdateManifest manifest;private File verified;
    private String status="尚未检查更新",backup="";private final PackageInfo installed;
    NativeUpdateController(Activity activity,PaneUi ui,NativeConnections computers,Host host){this.activity=activity;this.ui=ui;this.computers=computers;this.host=host;try{installed=activity.getPackageManager().getPackageInfo(activity.getPackageName(),NativeUpdateVerifier.signatureFlags());}catch(Exception e){throw new IllegalStateException(e);}}
    void detach(){body=null;}
    void close(){closed=true;main.removeCallbacksAndMessages(null);Call active=call;if(active!=null)active.cancel();worker.shutdownNow();}
    void mount(LinearLayout container){body=container;render();}
    private void render(){
        if(body==null||closed||activity.isFinishing())return;
        body.removeAllViews();
        LinearLayout title=ui.row();ui.pad(title,12,6);title.setMinimumHeight(ui.dp(56));
        title.addView(ui.iconButton("back","返回设置",activity::onBackPressed),new LinearLayout.LayoutParams(ui.dp(44),ui.dp(44)));
        title.addView(ui.heading("应用更新",22));body.addView(title);
        ScrollView scroll=new ScrollView(activity);LinearLayout content=ui.column();ui.pad(content,20,12);scroll.addView(content);body.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout current=ui.card();ui.pad(current,16,16);
        current.addView(ui.text("当前版本",13,PaneUi.MUTED));ui.gap(current,8);current.addView(ui.heading(installed.versionName,24));
        ui.gap(current,12);current.addView(ui.text(status,14,PaneUi.INK));
        if((activity.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0||NativeUpdateVerifier.debugCertificate(installed)){ui.gap(current,8);current.addView(ui.text("调试签名 · 仅支持同签名升级",12,PaneUi.AMBER));}
        content.addView(current);ui.gap(content,20);
        Button check=ui.primary(busy?"正在处理…":"检查更新",this::check);check.setEnabled(!busy);content.addView(check);
        ui.gap(content,12);content.addView(ui.text("来源：GitHub · kismet84/paneflow",12,PaneUi.MUTED));
        if(manifest!=null){
            ui.gap(content,20);LinearLayout release=ui.card();ui.pad(release,16,16);
            release.addView(ui.heading("版本 "+manifest.version,18));ui.gap(release,8);
            release.addView(ui.text("协议 "+manifest.minProtocol+"–"+manifest.maxProtocol+" · 本机 1",12,manifest.compatible()?PaneUi.GREEN:PaneUi.RED));
            if(!manifest.notes.isEmpty()){ui.gap(release,12);TextView notes=ui.text(manifest.notes,15,PaneUi.INK);notes.setTextIsSelectable(true);release.addView(notes);}
            ui.gap(release,16);
            if(manifest.versionCode>NativeUpdateVerifier.versionCode(installed)){Button download=ui.primary(verified==null?"下载更新（"+(manifest.size/1024/1024)+" MB）":"确认安装",verified==null?this::confirmDownload:this::confirmInstall);download.setEnabled(!busy&&manifest.compatible());release.addView(download);}
            else release.addView(ui.text("当前版本无需更新",14,PaneUi.GREEN));
            content.addView(release);
        }
        if(!backup.isEmpty()){ui.gap(content,12);content.addView(ui.text("本机加密备份已保留；取消或安装失败不影响绑定。",12,PaneUi.MUTED));}
    }
    private interface Job {void run()throws Exception;}
    private void background(Job job){if(busy||closed)return;busy=true;render();worker.execute(()->{try{job.run();}catch(Exception e){String message=e instanceof SecurityException||e instanceof IllegalArgumentException?e.getMessage():e instanceof FileNotFoundException?"暂未发布更新清单；现有功能可继续使用":"更新未完成（"+e.getClass().getSimpleName()+"），旧程序与数据保留";main.post(()->{status=message;});}finally{main.post(()->{busy=false;render();});}});}
    private Response fetch(String address)throws Exception {for(int redirect=0;redirect<=5;redirect++){if(!NativeUpdatePolicy.fetchUrl(address))throw new SecurityException("拒绝非受信更新来源或重定向");Call next=client.newCall(new Request.Builder().url(address).header("Accept","application/octet-stream").build());call=next;Response response=next.execute();if(response.isRedirect()){String location=response.header("Location");response.close();if(location==null)throw new IOException("缺少重定向地址");address=new URI(address).resolve(location).toString();continue;}if(response.code()==404){response.close();throw new FileNotFoundException();}if(!response.isSuccessful()){response.close();throw new IOException("更新服务未成功响应");}return response;}throw new SecurityException("更新重定向次数过多");}
    void check(){background(()->{byte[] data;try(Response response=fetch(NativeUpdatePolicy.MANIFEST_URL)){if(response.body()==null)throw new IOException();try(InputStream in=response.body().byteStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>256*1024)throw new SecurityException("更新清单过大");out.write(buffer,0,n);}data=out.toByteArray();}}NativeUpdateManifest candidate=new NativeUpdateManifest(new JSONObject(new String(data,StandardCharsets.UTF_8)));main.post(()->{manifest=candidate;verified=null;status=candidate.compatible()?"已读取可信发布清单":"协议不兼容，请先阅读兼容要求";});});}
    private void confirmDownload(){if(manifest==null)return;LinearLayout content=ui.column();content.addView(ui.text("下载 "+manifest.version+"，完成后核对大小、SHA-256、包名、版本和当前安装证书。此步不会安装。",15,PaneUi.MUTED));ui.gap(content,18);Dialog dialog=host.sheet("下载此版本？",content);final NativeUpdateManifest candidate=manifest;content.addView(ui.primary("确认下载",()->{dialog.dismiss();download(candidate);}));}
    private void download(NativeUpdateManifest candidate){background(()->{File directory=new File(activity.getFilesDir(),"updates");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException();File partial=new File(directory,candidate.sha256+".part"),apk=new File(directory,candidate.sha256+".apk");long total=0;try{try(Response response=fetch(candidate.url)){if(response.body()==null)throw new IOException();long declared=response.body().contentLength();if(declared>=0&&declared!=candidate.size)throw new SecurityException("安装包响应大小不符");try(InputStream in=response.body().byteStream();FileOutputStream out=new FileOutputStream(partial)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){total+=n;if(total>candidate.size)throw new SecurityException("安装包超过清单大小");out.write(buffer,0,n);}out.getFD().sync();}}NativeUpdateVerifier.verify(activity,partial,candidate);java.nio.file.Files.move(partial.toPath(),apk.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);main.post(()->{manifest=candidate;verified=apk;status="安装包校验通过，尚未安装";});}finally{if(partial.exists()&&!partial.delete())main.post(()->status="临时下载文件保留在本机，可稍后重试");}});}
    private void confirmInstall(){if(manifest==null||verified==null)return;if(!activity.getPackageManager().canRequestPackageInstalls()){LinearLayout content=ui.column();content.addView(ui.text("Android 尚未允许 PaneFlow 请求安装更新。请在系统设置授权后返回，再次点击确认安装；不会自动开始安装。",15,PaneUi.MUTED));Dialog dialog=host.sheet("允许安装应用更新",content);content.addView(ui.primary("打开系统授权设置",()->{dialog.dismiss();activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName())));}));return;}LinearLayout content=ui.column();content.addView(ui.text("核对各电脑当前会话、队列、审批和未确认回执，再备份本机加密数据。历史列表中其他会话的状态不阻止更新，最后由 Android 确认覆盖安装。",15,PaneUi.MUTED));ui.gap(content,18);Dialog dialog=host.sheet("安装 "+manifest.version+"？",content);content.addView(ui.primary("核对并继续",()->{dialog.dismiss();freshGuard(this::prepareInstall);}));}
    private void freshGuard(Runnable next){if(busy)return;host.flushInputs();long requested=System.currentTimeMillis();try{for(NativeConnection c:computers.all())if(c.paired()){if(!c.authenticated)throw new IllegalStateException(c.name()+"：离线，不能确认升级安全状态");c.command(NativeConnection.obj("type","snapshot.get"));c.reconcile();}}catch(Exception e){host.error(e.getMessage());return;}busy=true;status="正在核对全部电脑的最新状态…";render();pollGuard(requested,System.currentTimeMillis()+15000,next);}
    private void pollGuard(long requested,long deadline,Runnable next){if(closed)return;boolean received=true;for(NativeConnection c:computers.all())if(c.paired()&&c.lastSnapshotAt<requested)received=false;if(!received&&System.currentTimeMillis()<deadline){main.postDelayed(()->pollGuard(requested,deadline,next),150);return;}busy=false;String reason=received?NativeUpdateGuard.check(computers.all(),System.currentTimeMillis()):"等待最新电脑状态超时";if(!reason.isEmpty()){status="更新暂缓："+reason;render();return;}next.run();}
    private void prepareInstall(){final NativeUpdateManifest candidate=manifest;final File apk=verified;host.flushInputs();for(NativeConnection c:computers.all())if(c.paired()){String prefs="legacy".equals(c.computerId)?"native-device":"native-device-"+c.computerId;if(!activity.getSharedPreferences(prefs,0).edit().putLong("updateBackupAt",System.currentTimeMillis()).commit()){host.error("身份配置无法落盘，升级已停止");return;}}background(()->{NativeUpdateVerifier.verify(activity,apk,candidate);File material=NativeUpdateBackup.create(activity,candidate.version);main.post(()->{if(closed||activity.isFinishing()||activity.isDestroyed())return;backup=material.getName();String reason=NativeUpdateGuard.check(computers.all(),System.currentTimeMillis());if(!reason.isEmpty()){status="已备份，安装暂缓："+reason;return;}try{Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".updates",apk);Intent install=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);activity.startActivity(install);status="已交由 Android 确认安装；取消或失败会保留旧版本";}catch(Exception e){status="无法打开系统安装器，旧程序及备份保留";}});});}
}
