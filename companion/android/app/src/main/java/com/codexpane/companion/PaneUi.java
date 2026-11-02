package com.codexpane.companion;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.view.*;
import android.widget.*;

/** Shared native components for the approved light, edge-to-edge design. */
final class PaneUi {
    static final int BG = Color.rgb(245,245,247), INK = Color.rgb(29,29,31), MUTED = Color.rgb(110,110,119);
    static final int BLUE = Color.rgb(0,113,245), GREEN = Color.rgb(32,155,81), RED = Color.rgb(223,44,57);
    static final int AMBER = Color.rgb(170,103,0), LINE = Color.rgb(232,232,237), SOFT_BLUE = Color.rgb(232,242,255);
    final Context context;
    PaneUi(Context context) { this.context = context; }
    int dp(float v) { return Math.round(v * context.getResources().getDisplayMetrics().density); }
    LinearLayout column() { LinearLayout v = new LinearLayout(context); v.setOrientation(LinearLayout.VERTICAL); return v; }
    LinearLayout row() { LinearLayout v = new LinearLayout(context); v.setOrientation(LinearLayout.HORIZONTAL); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    TextView text(String value, int size, int color) {
        TextView v = new TextView(context); v.setText(value); v.setTextSize(size); v.setTextColor(color);
        v.setFontFeatureSettings("kern"); v.setIncludeFontPadding(false); return v;
    }
    TextView heading(String value, int size) { TextView v=text(value,size,INK); v.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL)); return v; }
    GradientDrawable rounded(int color, int radius) { GradientDrawable d=new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    android.graphics.drawable.Drawable clickable(int color, int radius) { return new RippleDrawable(ColorStateList.valueOf(0x180071F5),rounded(color,radius),rounded(Color.WHITE,radius)); }
    void pad(View view,int x,int y) { view.setPadding(dp(x),dp(y),dp(x),dp(y)); }
    void gap(LinearLayout parent,int h) { parent.addView(new View(context),new LinearLayout.LayoutParams(1,dp(h))); }
    void line(LinearLayout parent) { View l=new View(context); l.setBackgroundColor(LINE); parent.addView(l,new LinearLayout.LayoutParams(-1,dp(1))); }
    LinearLayout card() { LinearLayout c=column(); c.setBackground(rounded(Color.WHITE,18)); c.setClipToOutline(true); return c; }
    Button button(String label, int fill, int foreground, Runnable action) {
        Button b=new Button(context); b.setText(label); b.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{MUTED,foreground}));
        b.setTextSize(16); b.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL)); b.setAllCaps(false);
        b.setMinHeight(dp(50)); b.setMinimumHeight(dp(50)); b.setMinWidth(0); b.setMinimumWidth(0); b.setElevation(0);
        b.setStateListAnimator(null); b.setBackground(clickable(fill,14)); pad(b,14,10); b.setOnClickListener(v->action.run()); return b;
    }
    Button primary(String label,Runnable action) { return button(label,BLUE,Color.WHITE,action); }
    EditText input(String hint) {
        EditText e=new EditText(context); e.setTextSize(16); e.setTextColor(INK); e.setHintTextColor(MUTED); e.setHint(hint);
        e.setBackground(rounded(Color.WHITE,14)); e.setSelectAllOnFocus(false); pad(e,16,14); e.setMinHeight(dp(50)); return e;
    }
    Icon icon(String name,int color) { return new Icon(context,name,color); }
    View iconButton(String name,String description,Runnable action) {
        FrameLayout box=new FrameLayout(context); box.setMinimumWidth(dp(44)); box.setMinimumHeight(dp(44));
        Icon icon=icon(name,BLUE); FrameLayout.LayoutParams p=new FrameLayout.LayoutParams(dp(23),dp(23),Gravity.CENTER); box.addView(icon,p);
        box.setContentDescription(description); box.setFocusable(true); box.setBackground(clickable(Color.TRANSPARENT,22)); box.setOnClickListener(v->action.run()); return box;
    }
    LinearLayout setting(String symbol,String label,String detail,int color,Runnable action) {
        LinearLayout item=row(); pad(item,16,15); item.setMinimumHeight(dp(58)); item.setBackground(clickable(Color.WHITE,0));
        item.addView(icon(symbol,color),new LinearLayout.LayoutParams(dp(22),dp(22)));
        LinearLayout content=column(); LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(0,-2,1); cp.leftMargin=dp(13); item.addView(content,cp);
        content.addView(text(label,16,color));
        if(detail!=null&&!detail.isEmpty()) { TextView d=text(detail,12,MUTED); d.setMaxLines(2); d.setPadding(0,dp(5),0,0); content.addView(d); }
        if(action!=null) { item.addView(icon("chevron",MUTED),new LinearLayout.LayoutParams(dp(15),dp(15))); item.setOnClickListener(v->action.run()); }
        return item;
    }
    static final class Icon extends View {
        private final String name; private final Paint p=new Paint(Paint.ANTI_ALIAS_FLAG);
        Icon(Context c,String name,int color) { super(c); this.name=name; p.setColor(color); p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.7f); p.setStrokeCap(Paint.Cap.ROUND); p.setStrokeJoin(Paint.Join.ROUND); setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); }
        private void line(Canvas c,float... xy) { Path q=new Path(); q.moveTo(xy[0],xy[1]); for(int i=2;i<xy.length;i+=2)q.lineTo(xy[i],xy[i+1]); c.drawPath(q,p); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); canvas.save(); canvas.scale(getWidth()/24f,getHeight()/24f);
            switch(name) {
                case "back": line(canvas,15,5,8,12,15,19); break;
                case "chevron": line(canvas,9,5,16,12,9,19); break;
                case "plus": line(canvas,12,4,12,20); line(canvas,4,12,20,12); break;
                case "send": line(canvas,12,19,12,5,6,11); line(canvas,12,5,18,11); break;
                case "stop": canvas.drawRoundRect(6,6,18,18,3,3,p); break;
                case "check": line(canvas,5,12,10,17,19,7); break;
                case "close": line(canvas,6,6,18,18); line(canvas,18,6,6,18); break;
                case "more": p.setStyle(Paint.Style.FILL); for(int x=5;x<=19;x+=7) canvas.drawCircle(x,12,1.5f,p); p.setStyle(Paint.Style.STROKE); break;
                case "computer": canvas.drawRoundRect(4,3,20,16,2,2,p); line(canvas,2,20,22,20,20,16,4,16,2,20); break;
                case "chat": canvas.drawRoundRect(3,4,21,18,5,5,p); line(canvas,8,18,5,22,5,17); for(int x=8;x<=16;x+=4)canvas.drawCircle(x,11,.6f,p); break;
                case "tasks": canvas.drawRoundRect(5,3,19,21,3,3,p); line(canvas,9,8,15,8); line(canvas,9,12,15,12); line(canvas,9,16,13,16); break;
                case "settings": canvas.drawCircle(12,12,4,p); canvas.drawCircle(12,12,8,p); for(int a=0;a<360;a+=45){double r=Math.toRadians(a);line(canvas,(float)(12+8*Math.cos(r)),(float)(12+8*Math.sin(r)),(float)(12+10*Math.cos(r)),(float)(12+10*Math.sin(r)));}break;
                case "search": canvas.drawCircle(10,10,6,p);line(canvas,15,15,21,21);break;
                case "refresh": canvas.drawArc(4,4,20,20,35,290,false,p);line(canvas,21,4,21,10,15,10);break;
                case "fork":line(canvas,7,20,7,5);line(canvas,7,13,17,13,17,5);canvas.drawCircle(7,3,2,p);canvas.drawCircle(17,3,2,p);break;
                case "folder":line(canvas,3,7,3,20,21,20,21,7,12,7,10,4,3,4,3,7);break;
                case "copy":canvas.drawRoundRect(8,7,20,21,2,2,p);line(canvas,15,3,4,3,4,16);break;
                case "lock":canvas.drawRoundRect(5,10,19,21,2,2,p);canvas.drawArc(8,2,16,16,180,180,false,p);line(canvas,12,14,12,17);break;
                case "bell":line(canvas,5,17,7,14,7,9);canvas.drawArc(7,4,17,14,180,180,false,p);line(canvas,17,9,17,14,19,17,5,17);canvas.drawArc(10,18,14,22,0,180,false,p);break;
                case "trash":line(canvas,4,6,20,6);line(canvas,8,6,8,3,16,3,16,6);line(canvas,6,6,7,21,17,21,18,6);line(canvas,10,10,10,17);line(canvas,14,10,14,17);break;
                case "pane":canvas.drawRoundRect(3,3,15,17,3,3,p);canvas.drawRoundRect(9,8,21,22,3,3,p);break;
                default:canvas.drawCircle(12,12,9,p);line(canvas,12,11,12,17);canvas.drawCircle(12,7,.5f,p);
            } canvas.restore();
        }
    }
}
