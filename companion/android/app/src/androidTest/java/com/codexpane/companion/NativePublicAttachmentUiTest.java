package com.codexpane.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.drawable.BitmapDrawable;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inspector.WindowInspector;
import android.widget.HeaderViewListAdapter;
import android.widget.ListAdapter;
import android.widget.ListView;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import static org.junit.Assert.*;

/** Explicit semantic UI check against the already-created public validation conversation. */
@RunWith(AndroidJUnit4.class)
public class NativePublicAttachmentUiTest {
    private static final String IMAGE="paneflow-public-red-square.png",FILE="paneflow-public-08.txt";
    private NativeChatActivity activity;
    private NativeConnection connection;
    private String thread,phase="preflight";
    private long totalDeadline;

    private <T>T main(Callable<T> action)throws Exception{AtomicReference<T> result=new AtomicReference<>();AtomicReference<Throwable> failure=new AtomicReference<>();InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{try{result.set(action.call());}catch(Throwable e){failure.set(e);}});if(failure.get()!=null)throw new AssertionError("UI inspection failed");return result.get();}
    private void phase(String name){phase=name;Bundle status=new Bundle();status.putString("phase",name);status.putString("threadId",thread);InstrumentationRegistry.getInstrumentation().sendStatus(0,status);}
    private void unlocked(){Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();KeyguardManager keyguard=context.getSystemService(KeyguardManager.class);PowerManager power=context.getSystemService(PowerManager.class);assertNotNull(keyguard);assertNotNull(power);assertFalse("Device must already be unlocked",keyguard.isKeyguardLocked());assertFalse("Device authentication required",keyguard.isDeviceLocked());assertTrue("Display must already be interactive",power.isInteractive());}
    private void waitFor(Callable<Boolean> check)throws Exception{long end=Math.min(totalDeadline,System.currentTimeMillis()+30000);while(System.currentTimeMillis()<end){if(main(check))return;Thread.sleep(100);}throw new AssertionError("UI step deadline reached");}
    private ListView chatList()throws Exception{Field field=NativeChatActivity.class.getDeclaredField("chatList");field.setAccessible(true);return (ListView)field.get(activity);}
    private JSONArray items(ListView list)throws Exception{if(list==null||list.getAdapter()==null)return new JSONArray();ListAdapter adapter=list.getAdapter();if(adapter instanceof HeaderViewListAdapter)adapter=((HeaderViewListAdapter)adapter).getWrappedAdapter();Field field=adapter.getClass().getDeclaredField("items");field.setAccessible(true);return (JSONArray)field.get(adapter);}
    private int attachmentPosition(ListView list,String filename)throws Exception{JSONArray values=items(list);for(int i=0;i<values.length();i++){JSONObject item=values.optJSONObject(i);JSONArray attachments=item==null?null:item.optJSONArray("attachments");if(attachments==null)continue;for(int j=0;j<attachments.length();j++){JSONObject attachment=attachments.optJSONObject(j);if(attachment!=null&&filename.equals(attachment.optString("name")))return i+list.getHeaderViewsCount();}}return -1;}
    private View find(View root,Predicate<View> test){if(test.test(root))return root;if(root instanceof ViewGroup){ViewGroup group=(ViewGroup)root;for(int i=0;i<group.getChildCount();i++){View found=find(group.getChildAt(i),test);if(found!=null)return found;}}return null;}
    private View window(Predicate<View> test){java.util.List<View> roots=WindowInspector.getGlobalWindowViews();for(int i=roots.size()-1;i>=0;i--){View found=find(roots.get(i),view->view.isShown()&&test.test(view));if(found!=null)return found;}return null;}
    private boolean text(View view,String value){return view instanceof TextView&&value.contentEquals(((TextView)view).getText());}
    private void clickAttachment(String filename)throws Exception{
        phase("attachmentUi.locate."+(IMAGE.equals(filename)?"image":"file"));
        waitFor(()->{ListView list=chatList();return list!=null&&thread.equals(connection.snapshot.optString("activeThreadId"))&&attachmentPosition(list,filename)>=0;});
        main(()->{ListView list=chatList();list.setSelectionFromTop(attachmentPosition(list,filename),0);return null;});
        waitFor(()->{ListView list=chatList();View target=find(list,view->("查看附件 "+filename).equals(String.valueOf(view.getContentDescription()))&&view.isShown()&&view.isEnabled());if(target==null)return false;Rect visible=new Rect();if(!target.getGlobalVisibleRect(visible)||visible.height()<Math.min(30,target.getHeight())){target.requestRectangleOnScreen(new Rect(0,0,target.getWidth(),target.getHeight()),true);return false;}return true;});
        main(()->{View target=find(chatList(),view->("查看附件 "+filename).equals(String.valueOf(view.getContentDescription()))&&view.isShown()&&view.isEnabled());assertNotNull("Attachment action unavailable",target);assertTrue("Attachment did not handle click",target.performClick());return null;});
    }
    private void screenshot(String name)throws Exception{Bitmap bitmap=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();assertNotNull("Screenshot unavailable",bitmap);File directory=InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null);assertNotNull(directory);try(FileOutputStream output=new FileOutputStream(new File(directory,name))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}finally{bitmap.recycle();}}
    private void closeAndCheckAnchor(String filename)throws Exception{
        main(()->{View close=window(view->text(view,"关闭预览"));assertNotNull(close);assertTrue(close.performClick());return null;});
        waitFor(()->window(view->text(view,"关闭预览"))==null);
        // Let the post-dialog layout and scheduled render settle before inspecting the row anchor.
        Thread.sleep(300);
        main(()->{ListView list=chatList();int position=attachmentPosition(list,filename);assertTrue("Attachment row lost",position>=0);assertTrue("Reader jumped past attachment history",list.getFirstVisiblePosition()<=position&&list.getLastVisiblePosition()>=position);return null;});
    }
    @Test public void publicImageAndFilePreviewsPreserveHistoryPosition()throws Exception{
        Bundle args=InstrumentationRegistry.getArguments();Assume.assumeTrue("true".equals(args.getString("livePublicUi")));thread=args.getString("threadId","");assertEquals("Explicit UUID thread required",UUID.fromString(thread).toString(),thread);assertTrue("Window inspection requires Android 10+",android.os.Build.VERSION.SDK_INT>=29);totalDeadline=System.currentTimeMillis()+120000;unlocked();phase("attachmentUi.preflight");
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();ActivityScenario<NativeChatActivity> scenario=ActivityScenario.launch(NativeChatActivity.class);
        try{
            scenario.onActivity(screen->{activity=screen;unlocked();screen.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);connection=NativeConnections.get(context).find("legacy");assertNotNull("Existing production binding required",connection);assertTrue(connection.paired());assertEquals(InstrumentationRegistry.getArguments().getString("expectedPublicOrigin", ""),connection.relay());screen.onNewIntent(new Intent().setAction("com.codexpane.OPEN_CHAT").putExtra("computerId","legacy").putExtra("threadId",thread));});
            waitFor(()->connection.authenticated&&connection.supports("attachmentsV1")&&thread.equals(connection.snapshot.optString("activeThreadId"))&&chatList()!=null);
            clickAttachment(IMAGE);phase("attachmentUi.wait.image.preview");waitFor(()->window(view->text(view,"关闭预览"))!=null&&window(view->view instanceof NativeAttachmentImage&&view.getWidth()>0&&view.getHeight()>0)!=null);
            main(()->{NativeAttachmentImage image=(NativeAttachmentImage)window(view->view instanceof NativeAttachmentImage);assertNotNull(image);assertTrue(image.getDrawable() instanceof BitmapDrawable);Bitmap decoded=((BitmapDrawable)image.getDrawable()).getBitmap();assertEquals("Expected uploaded red image",android.graphics.Color.RED,decoded.getPixel(decoded.getWidth()/2,decoded.getHeight()/2));return null;});
            screenshot("public-image-preview.png");phase("attachmentUi.image.preview.verified");closeAndCheckAnchor(IMAGE);phase("attachmentUi.image.anchor.preserved");
            clickAttachment(FILE);phase("attachmentUi.wait.file.preview");waitFor(()->window(view->text(view,"关闭预览"))!=null&&window(view->view instanceof TextView&&((TextView)view).getText().toString().contains("文件已通过完整性校验"))!=null);screenshot("public-file-preview.png");phase("attachmentUi.file.preview.verified");closeAndCheckAnchor(FILE);unlocked();phase("attachmentUi.complete");
        }catch(Throwable error){throw new AssertionError("Public attachment UI verification failed at "+phase+"; no task was submitted",error);}
        finally{if(activity!=null)main(()->{activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);return null;});/* Leave the ordinary conversation visible; no shared connection teardown. */}
    }
}
