package com.codexpane.companion;

import android.graphics.Color;
import android.graphics.Typeface;
import android.text.*;
import android.text.style.*;
import android.view.Gravity;
import android.widget.*;
import java.util.regex.*;

/** Small safe native renderer. No HTML, WebView, scripts or remote image requests. */
final class PaneMarkdown {
    private static CharSequence inline(String source) {
        SpannableStringBuilder out=new SpannableStringBuilder();
        Matcher m=Pattern.compile("(\\*\\*(.+?)\\*\\*|`([^`]+)`)").matcher(source); int last=0;
        while(m.find()) { out.append(source.substring(last,m.start()));int start=out.length();out.append(m.group(2)!=null?m.group(2):m.group(3));out.setSpan(m.group(2)!=null?new StyleSpan(Typeface.BOLD):new TypefaceSpan("monospace"),start,out.length(),Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);last=m.end(); }
        out.append(source.substring(last)); return out;
    }
    static void append(LinearLayout parent,String source,PaneUi ui,java.util.function.Consumer<String> copy) {
        String[] parts=source.split("```",-1);
        for(int part=0;part<parts.length;part++) {
            String block=parts[part]; if(block.trim().isEmpty())continue;
            if(part%2==1) {
                int newline=block.indexOf('\n'); String language=newline>=0?block.substring(0,newline).trim():"代码";
                String code=newline>=0?block.substring(newline+1).replaceFirst("\\n$",""):block;
                LinearLayout card=ui.card();card.setBackground(ui.rounded(PaneUi.BG,12));ui.pad(card,12,12);
                LinearLayout head=ui.row();TextView label=ui.text(language.isEmpty()?"代码":language,12,PaneUi.MUTED);head.addView(label,new LinearLayout.LayoutParams(0,-2,1));
                head.addView(ui.iconButton("copy","复制代码",()->copy.accept(code)),new LinearLayout.LayoutParams(ui.dp(40),ui.dp(36)));card.addView(head);
                HorizontalScrollView horizontal=new HorizontalScrollView(ui.context);TextView body=ui.text(code,13,PaneUi.INK);body.setTypeface(Typeface.MONOSPACE);body.setTextIsSelectable(true);body.setLineSpacing(ui.dp(3),1);horizontal.addView(body);card.addView(horizontal);parent.addView(card);ui.gap(parent,12);
            } else {
                // Paragraphs retain line breaks; only common Markdown markers are styled.
                for(String paragraph:block.trim().split("\\n\\s*\\n")) {
                    boolean heading=paragraph.matches("(?s)^#{1,6} .*" );
                    String clean=paragraph.replaceFirst("^#{1,6} ","").replaceAll("(?m)^[-*] ","• ");
                    TextView body=ui.text("",heading?19:16,PaneUi.INK);body.setText(inline(clean));body.setTextIsSelectable(true);body.setLineSpacing(ui.dp(5),1);
                    if(heading)body.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));parent.addView(body);ui.gap(parent,12);
                }
            }
        }
    }
}
