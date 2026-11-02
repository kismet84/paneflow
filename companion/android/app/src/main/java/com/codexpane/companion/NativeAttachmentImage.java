package com.codexpane.companion;

import android.content.Context;
import android.graphics.*;
import android.view.*;
import android.widget.ImageView;

/** Bounded decode plus pinch zoom and pan; never allocates a full camera bitmap. */
final class NativeAttachmentImage extends ImageView {
    private final Matrix transform=new Matrix();
    private final ScaleGestureDetector scale;
    private float x,y,zoom=1;
    NativeAttachmentImage(Context context,byte[] data){super(context);setScaleType(ScaleType.MATRIX);BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(data,0,data.length,options);if(options.outWidth<=0||options.outHeight<=0)throw new IllegalArgumentException("无法解码图片");options.inSampleSize=1;while(options.outWidth/options.inSampleSize>2048||options.outHeight/options.inSampleSize>2048)options.inSampleSize*=2;options.inJustDecodeBounds=false;setImageBitmap(BitmapFactory.decodeByteArray(data,0,data.length,options));setContentDescription("图片预览，可双指缩放和拖动");scale=new ScaleGestureDetector(context,new ScaleGestureDetector.SimpleOnScaleGestureListener(){public boolean onScale(ScaleGestureDetector d){float next=Math.max(.5f,Math.min(8f,zoom*d.getScaleFactor()));transform.postScale(next/zoom,next/zoom,d.getFocusX(),d.getFocusY());zoom=next;setImageMatrix(transform);return true;}});}
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);if(getDrawable()!=null&&w>0&&h>0){float s=Math.min((float)w/getDrawable().getIntrinsicWidth(),(float)h/getDrawable().getIntrinsicHeight());transform.setScale(s,s);transform.postTranslate((w-getDrawable().getIntrinsicWidth()*s)/2,(h-getDrawable().getIntrinsicHeight()*s)/2);zoom=1;setImageMatrix(transform);}}
    @Override public boolean onTouchEvent(android.view.MotionEvent e){scale.onTouchEvent(e);if(e.getActionMasked()==MotionEvent.ACTION_DOWN){x=e.getX();y=e.getY();}else if(e.getActionMasked()==MotionEvent.ACTION_MOVE&&!scale.isInProgress()){transform.postTranslate(e.getX()-x,e.getY()-y);setImageMatrix(transform);x=e.getX();y=e.getY();}return true;}
}
