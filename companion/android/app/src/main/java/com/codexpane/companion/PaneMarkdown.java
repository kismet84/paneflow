package com.codexpane.companion;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.*;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import java.net.URI;
import java.util.*;
import java.util.function.Consumer;
import java.util.regex.*;

/** Native, bounded Markdown renderer. HTML stays text; images never trigger network requests. */
final class PaneMarkdown {
    private static final Pattern HEADING=Pattern.compile("^ {0,3}(#{1,6})\\s+(.+?)(?:\\s+#+)?\\s*$");
    private static final Pattern LIST=Pattern.compile("^( *)([-+*]|\\d+[.)])\\s+(.*)$");
    private static final Pattern FENCE=Pattern.compile("^ {0,3}(`{3,}|~{3,})(.*)$");
    private static final Pattern DIVIDER=Pattern.compile("^ {0,3}(?:\\*\\s*){3,}$|^ {0,3}(?:-\\s*){3,}$|^ {0,3}(?:_\\s*){3,}$");
    static boolean safeLink(String value) {
        try {URI uri=new URI(value);return ("https".equalsIgnoreCase(uri.getScheme())||"http".equalsIgnoreCase(uri.getScheme()))&&uri.getHost()!=null&&uri.getUserInfo()==null;}
        catch(Exception ignored){return false;}
    }
    private static final class WebLink extends URLSpan {
        WebLink(String value){super(value);}
        @Override public void onClick(View widget){if(!safeLink(getURL()))return;try{widget.getContext().startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(getURL())).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}catch(ActivityNotFoundException|SecurityException ignored){Toast.makeText(widget.getContext(),"没有可用的浏览器",Toast.LENGTH_SHORT).show();}}
    }
    static CharSequence inline(String source){return inline(source,0,new int[]{Math.max(4096,source.length()*12)});}
    private static CharSequence inline(String source,int depth,int[] budget) {
        if(depth>8)return source;
        SpannableStringBuilder out=new SpannableStringBuilder();
        for(int i=0;i<source.length();) {
            if(--budget[0]<0){out.append(source.substring(i));break;}
            char c=source.charAt(i);
            if(c=='\\'&&i+1<source.length()&&"\\`*_{}[]()#+-.!|>~".indexOf(source.charAt(i+1))>=0){out.append(source.charAt(i+1));i+=2;continue;}
            if(c=='`') {int count=1;while(i+count<source.length()&&source.charAt(i+count)=='`')count++;String marker=source.substring(i,i+count);int end=source.indexOf(marker,i+count);if(end>=0){int start=out.length();out.append(source.substring(i+count,end));span(out,new TypefaceSpan("monospace"),start);span(out,new BackgroundColorSpan(PaneUi.BG),start);i=end+count;continue;}out.append(marker);i+=count;continue;}
            boolean image=c=='!'&&i+1<source.length()&&source.charAt(i+1)=='[';
            if(c=='['||image) {
                int labelStart=i+(image?2:1),labelEnd=findUnescaped(source,']',labelStart,budget);
                if(labelEnd>=0&&labelEnd+1<source.length()&&source.charAt(labelEnd+1)=='('){int end=closingParen(source,labelEnd+2,budget);if(end>=0){String url=source.substring(labelEnd+2,end).trim();if(url.startsWith("<")&&url.endsWith(">"))url=url.substring(1,url.length()-1);int start=out.length();out.append(inline(source.substring(labelStart,labelEnd),depth+1,budget));if(image)out.append(" [图片]");else if(safeLink(url))span(out,new WebLink(url),start);else out.append(" (").append(url).append(")");i=end+1;continue;}}
            }
            String marker=null;Object style=null;
            for(String token:new String[]{"***","___","**","__","~~","*","_"}) {
                if(!source.startsWith(token,i))continue;
                if(token.charAt(0)=='_'&&i>0&&Character.isLetterOrDigit(source.charAt(i-1)))continue;
                int begin=i+token.length();if(begin>=source.length()||Character.isWhitespace(source.charAt(begin)))continue;
                int end=source.indexOf(token,begin);if(end<=begin||Character.isWhitespace(source.charAt(end-1)))continue;
                if(token.charAt(0)=='_'&&end+token.length()<source.length()&&Character.isLetterOrDigit(source.charAt(end+token.length())))continue;
                marker=token;style=token.equals("~~")?new StrikethroughSpan():new StyleSpan(token.length()==3?Typeface.BOLD_ITALIC:token.length()==2?Typeface.BOLD:Typeface.ITALIC);break;
            }
            if(marker!=null){int end=source.indexOf(marker,i+marker.length()),start=out.length();out.append(inline(source.substring(i+marker.length(),end),depth+1,budget));span(out,style,start);i=end+marker.length();continue;}
            out.append(c);i++;
        }
        return out;
    }
    private static void span(SpannableStringBuilder value,Object span,int start){if(value.length()>start)value.setSpan(span,start,value.length(),Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);}
    private static int findUnescaped(String text,char target,int start,int[] budget){for(int i=start;i<text.length();i++){if(--budget[0]<0)return -1;if(text.charAt(i)=='\\'){i++;continue;}if(text.charAt(i)==target)return i;}return -1;}
    private static int closingParen(String text,int start,int[] budget){int level=1;for(int i=start;i<text.length();i++){if(--budget[0]<0)return -1;char c=text.charAt(i);if(c=='\\'){i++;continue;}if(c=='(')level++;else if(c==')'&&--level==0)return i;}return -1;}
    private static TextView text(PaneUi ui,String value,int size){TextView v=ui.text("",size,PaneUi.INK);v.setText(inline(value));v.setTextIsSelectable(true);v.setLinkTextColor(PaneUi.BLUE);v.setMovementMethod(LinkMovementMethod.getInstance());v.setLineSpacing(ui.dp(5),1);return v;}
    static void append(LinearLayout parent,String source,PaneUi ui,Consumer<String> copy){if(source!=null&&!source.isEmpty())render(parent,source.replace("\r\n","\n").replace('\r','\n').split("\n",-1),ui,copy,0);}
    private static void render(LinearLayout parent,String[] lines,PaneUi ui,Consumer<String> copy,int quoteDepth) {
        for(int i=0;i<lines.length;) {
            String line=lines[i];if(line.trim().isEmpty()){i++;continue;}
            Matcher fence=FENCE.matcher(line),heading=HEADING.matcher(line),list=LIST.matcher(line);
            if(fence.matches()){String marker=fence.group(1),language=fence.group(2).trim();int end=i+1;while(end<lines.length&&!closesFence(lines[end],marker))end++;StringBuilder code=new StringBuilder();for(int n=i+1;n<end;n++){if(n>i+1)code.append('\n');code.append(lines[n]);}code(parent,code.toString(),language,ui,copy);i=end<lines.length?end+1:end;continue;}
            if(heading.matches()){int level=heading.group(1).length();TextView v=text(ui,heading.group(2),new int[]{26,23,21,19,18,17}[level-1]);v.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));if(android.os.Build.VERSION.SDK_INT>=28)v.setAccessibilityHeading(true);parent.addView(v);ui.gap(parent,12);i++;continue;}
            if(DIVIDER.matcher(line).matches()){ui.line(parent);ui.gap(parent,12);i++;continue;}
            if(i+1<lines.length&&line.contains("|")&&tableDivider(lines[i+1])){int end=i+2;while(end<lines.length&&!lines[end].trim().isEmpty()&&lines[end].contains("|"))end++;table(parent,lines,i,end,ui);i=end;continue;}
            if(line.trim().startsWith(">")&&quoteDepth<6){List<String> quoted=new ArrayList<>();while(i<lines.length&&lines[i].trim().startsWith(">")){quoted.add(lines[i].replaceFirst("^\\s*> ?",""));i++;}LinearLayout row=ui.row();row.setGravity(Gravity.TOP);View border=new View(ui.context);border.setBackgroundColor(PaneUi.LINE);row.addView(border,new LinearLayout.LayoutParams(ui.dp(3),-1));LinearLayout content=ui.column();ui.pad(content,12,6);content.setBackground(ui.rounded(PaneUi.BG,8));row.addView(content,new LinearLayout.LayoutParams(0,-2,1));render(content,quoted.toArray(new String[0]),ui,copy,quoteDepth+1);parent.addView(row);ui.gap(parent,10);continue;}
            if(list.matches()){int indent=Math.min(6,list.group(1).length()/2);String marker=list.group(2),value=list.group(3),bullet=marker.matches("\\d+[.)]")?marker:"•";if(value.matches("^\\[[ xX]\\] .*")){bullet=value.charAt(1)==' '?"☐":"☑";value=value.substring(4);}LinearLayout row=ui.row();row.setGravity(Gravity.TOP);row.setPadding(ui.dp(indent*16),0,0,0);TextView dot=text(ui,bullet,16);dot.setPadding(0,0,ui.dp(8),0);row.addView(dot,new LinearLayout.LayoutParams(-2,-2));row.addView(text(ui,value,16),new LinearLayout.LayoutParams(0,-2,1));parent.addView(row);ui.gap(parent,7);i++;continue;}
            StringBuilder paragraph=new StringBuilder(line);i++;while(i<lines.length&&!lines[i].trim().isEmpty()&&!startsBlock(lines,i)){paragraph.append('\n').append(lines[i]);i++;}parent.addView(text(ui,paragraph.toString(),16));ui.gap(parent,12);
        }
    }
    private static boolean startsBlock(String[] lines,int i){String line=lines[i];return HEADING.matcher(line).matches()||FENCE.matcher(line).matches()||LIST.matcher(line).matches()||DIVIDER.matcher(line).matches()||line.trim().startsWith(">")||(i+1<lines.length&&line.contains("|")&&tableDivider(lines[i+1]));}
    private static boolean closesFence(String line,String marker){String value=line.trim();if(value.length()<marker.length())return false;for(int i=0;i<value.length();i++)if(value.charAt(i)!=marker.charAt(0))return false;return true;}
    private static void code(LinearLayout parent,String value,String language,PaneUi ui,Consumer<String> copy) {
        LinearLayout card=ui.card();card.setBackground(ui.rounded(PaneUi.BG,12));ui.pad(card,12,12);LinearLayout head=ui.row();head.addView(ui.text(language.isEmpty()?"代码":language,12,PaneUi.MUTED),new LinearLayout.LayoutParams(0,-2,1));head.addView(ui.iconButton("copy","复制代码",()->copy.accept(value)),new LinearLayout.LayoutParams(ui.dp(44),ui.dp(40)));card.addView(head);
        HorizontalScrollView horizontal=new HorizontalScrollView(ui.context);horizontal.setContentDescription("代码横向滚动");TextView body=ui.text(value,13,PaneUi.INK);body.setTypeface(Typeface.MONOSPACE);body.setTextIsSelectable(true);body.setLineSpacing(ui.dp(3),1);horizontal.addView(body);card.addView(horizontal,new LinearLayout.LayoutParams(-1,-2));
        if(value.split("\n",-1).length>14||value.length()>3000){body.setMaxLines(14);Button toggle=ui.button("展开全部代码",Color.TRANSPARENT,PaneUi.BLUE,()->{});toggle.setOnClickListener(v->{boolean expand=body.getMaxLines()!=Integer.MAX_VALUE;body.setMaxLines(expand?Integer.MAX_VALUE:14);toggle.setText(expand?"收起代码":"展开全部代码");});card.addView(toggle);}parent.addView(card);ui.gap(parent,12);
    }
    static List<String> tableCells(String line) {
        String trimmed=line.trim();if(trimmed.startsWith("|"))trimmed=trimmed.substring(1);if(trimmed.endsWith("|")&&!trimmed.endsWith("\\|"))trimmed=trimmed.substring(0,trimmed.length()-1);List<String> cells=new ArrayList<>();StringBuilder cell=new StringBuilder();int codeTicks=0;
        for(int i=0;i<trimmed.length();i++){char c=trimmed.charAt(i);if(c=='\\'&&i+1<trimmed.length()){cell.append(c).append(trimmed.charAt(++i));continue;}if(c=='`'){int ticks=1;while(i+ticks<trimmed.length()&&trimmed.charAt(i+ticks)=='`')ticks++;if(codeTicks==0)codeTicks=ticks;else if(codeTicks==ticks)codeTicks=0;for(int n=0;n<ticks;n++)cell.append('`');i+=ticks-1;continue;}if(c=='|'&&codeTicks==0){cells.add(cell.toString().trim());cell.setLength(0);}else cell.append(c);}cells.add(cell.toString().trim());return cells;
    }
    private static boolean tableDivider(String line){List<String> cells=tableCells(line);if(cells.isEmpty())return false;for(String cell:cells)if(!cell.matches(":?-{3,}:?"))return false;return true;}
    private static void table(LinearLayout parent,String[] lines,int start,int end,PaneUi ui) {
        List<String> headers=tableCells(lines[start]),align=tableCells(lines[start+1]);int columns=headers.size();HorizontalScrollView horizontal=new HorizontalScrollView(ui.context);horizontal.setContentDescription("表格横向滚动");TableLayout table=new TableLayout(ui.context);table.setBackground(ui.rounded(PaneUi.BG,10));
        for(int row=start;row<end;row++){if(row==start+1)continue;List<String> cells=tableCells(lines[row]);TableRow tr=new TableRow(ui.context);for(int col=0;col<Math.max(columns,cells.size());col++){TextView cell=text(ui,col<cells.size()?cells.get(col):"",14);cell.setMinWidth(ui.dp(100));cell.setMaxWidth(ui.dp(260));ui.pad(cell,12,10);if(row==start){cell.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));cell.setBackgroundColor(PaneUi.LINE);}String alignment=col<align.size()?align.get(col):"";cell.setGravity(alignment.startsWith(":")&&alignment.endsWith(":")?Gravity.CENTER:alignment.endsWith(":")?Gravity.RIGHT:Gravity.LEFT);tr.addView(cell,new TableRow.LayoutParams(-2,-2));}table.addView(tr);}horizontal.addView(table);parent.addView(horizontal,new LinearLayout.LayoutParams(-1,-2));ui.gap(parent,12);
    }
}
