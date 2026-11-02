package com.codexpane.companion;

import android.text.Spanned;
import android.text.style.*;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeMarkdownTest {
    @org.junit.ClassRule public static NativeTestCpuRule cpu = new NativeTestCpuRule();
    private static List<View> views(View root){List<View> values=new ArrayList<>();values.add(root);if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)values.addAll(views(((ViewGroup)root).getChildAt(i)));return values;}
    private static String text(View root){StringBuilder result=new StringBuilder();for(View view:views(root))if(view instanceof TextView)result.append(((TextView)view).getText()).append('\n');return result.toString();}
    @Test public void inlineFormatsAndOnlyWebLinksBecomeClickable(){Spanned value=(Spanned)PaneMarkdown.inline("**粗体** *斜体* ~~旧文~~ `a*b` [网页](https://example.com/a_(b)) [拒绝](javascript:alert(1)) snake_case");assertEquals(2,value.getSpans(0,value.length(),StyleSpan.class).length);assertEquals(1,value.getSpans(0,value.length(),StrikethroughSpan.class).length);assertEquals(1,value.getSpans(0,value.length(),TypefaceSpan.class).length);URLSpan[] links=value.getSpans(0,value.length(),URLSpan.class);assertEquals(1,links.length);assertEquals("https://example.com/a_(b)",links[0].getURL());assertTrue(value.toString().contains("a*b"));assertTrue(value.toString().contains("snake_case"));assertFalse(PaneMarkdown.safeLink("file:///C:/private"));assertFalse(PaneMarkdown.safeLink("https://user:password@example.com"));}
    @Test public void tableEscapesAndCodePipesStayInOneCell(){assertEquals(Arrays.asList("a\\|b","`x|y`","c"),PaneMarkdown.tableCells("| a\\|b | `x|y` | c |"));}
    @Test public void adversarialUnclosedMarkersKeepAllText(){char[] many=new char[20000];Arrays.fill(many,'[');String source=new String(many);assertEquals(source,PaneMarkdown.inline(source).toString());Arrays.fill(many,'`');source=new String(many);assertEquals(source,PaneMarkdown.inline(source).toString());}
    @Test public void headingsListsQuoteAndTableRenderNatively(){InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{PaneUi ui=new PaneUi(InstrumentationRegistry.getInstrumentation().getTargetContext());LinearLayout parent=ui.column();PaneMarkdown.append(parent,"# 一级\n## 二级\n- 父项\n  - 子项\n> 引用\n\n| 名称 | 值 |\n| --- | ---: |\n| **A** | 2 |",ui,s->{});String rendered=text(parent);for(String expected:new String[]{"一级","二级","父项","子项","引用","名称","A","2"})assertTrue(expected,rendered.contains(expected));assertEquals(1,views(parent).stream().filter(v->v instanceof TableLayout).count());assertEquals(1,views(parent).stream().filter(v->v instanceof HorizontalScrollView).count());List<TextView> headings=new ArrayList<>();for(View v:views(parent))if(v instanceof TextView&&Arrays.asList("一级","二级").contains(((TextView)v).getText().toString()))headings.add((TextView)v);assertEquals(2,headings.size());assertTrue(headings.get(0).getTextSize()>headings.get(1).getTextSize());});}
    @Test public void unfinishedFencePreservesCodeAndCopyIncludesCollapsedTail(){InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{PaneUi ui=new PaneUi(InstrumentationRegistry.getInstrumentation().getTargetContext());LinearLayout parent=ui.column();StringBuilder code=new StringBuilder();for(int i=0;i<25;i++){if(i>0)code.append('\n');code.append("line ").append(i);}AtomicReference<String> copied=new AtomicReference<>();PaneMarkdown.append(parent,"```java\n"+code,ui,copied::set);assertTrue(text(parent).contains("line 24"));View copy=views(parent).stream().filter(v->"复制代码".contentEquals(v.getContentDescription()==null?"":v.getContentDescription())).findFirst().get();copy.performClick();assertEquals(code.toString(),copied.get());Button toggle=(Button)views(parent).stream().filter(v->v instanceof Button&&"展开全部代码".contentEquals(((Button)v).getText())).findFirst().get();toggle.performClick();assertEquals("收起代码",toggle.getText().toString());TextView body=(TextView)views(parent).stream().filter(v->v instanceof TextView&&((TextView)v).getText().toString().equals(code.toString())).findFirst().get();assertEquals(Integer.MAX_VALUE,body.getMaxLines());});}
    @Test public void imageAndHtmlRemainInertText(){InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{PaneUi ui=new PaneUi(InstrumentationRegistry.getInstrumentation().getTargetContext());LinearLayout parent=ui.column();PaneMarkdown.append(parent,"![截图](https://example.com/image.png)\n<script>alert(1)</script>",ui,s->{});assertTrue(text(parent).contains("截图 [图片]"));assertTrue(text(parent).contains("<script>"));assertFalse(views(parent).stream().anyMatch(v->v instanceof android.webkit.WebView||v instanceof ImageView));});}
}
