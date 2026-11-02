package com.codexpane.companion;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.*;
import android.widget.*;
import java.util.ArrayList;

/** System dictation is an editable draft input, never a task submission. */
final class NativeDictation implements RecognitionListener {
    static final int PERMISSION = 408;
    private final Activity activity;
    private SpeechRecognizer recognizer;
    private AlertDialog dialog;
    private EditText transcript;
    private TextView status;
    private java.util.function.Consumer<String> accept;
    NativeDictation(Activity activity) { this.activity=activity; }
    void open(java.util.function.Consumer<String> callback) {
        close();
        if(!SpeechRecognizer.isRecognitionAvailable(activity)) {
            new AlertDialog.Builder(activity).setTitle("语音输入暂不可用").setMessage("手机没有可用的系统语音识别服务。可以使用键盘的语音输入，识别后检查文字再发送。").setPositiveButton("知道了",null).show();return;
        }
        if(activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},PERMISSION);return;
        }
        accept=callback;
        PaneUi ui=new PaneUi(activity);LinearLayout body=ui.column();ui.pad(body,20,16);
        status=ui.text("正在聆听…识别由手机系统服务提供",14,PaneUi.MUTED);body.addView(status);ui.gap(body,12);
        transcript=ui.input("识别结果，可在结束后修改");transcript.setMinLines(3);body.addView(transcript);
        dialog=new AlertDialog.Builder(activity).setTitle("语音转文字").setView(body).setNegativeButton("取消",(d,w)->close()).setNeutralButton("停止录音",null).setPositiveButton("填入草稿",null).create();
        dialog.setOnDismissListener(d->destroyRecognizer());dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v->{if(recognizer!=null)recognizer.stopListening();status.setText("正在完成识别…");});
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{String value=transcript.getText().toString().trim();if(!value.isEmpty()&&accept!=null)accept.accept(value);close();});
        try {
            recognizer=SpeechRecognizer.createSpeechRecognizer(activity);recognizer.setRecognitionListener(this);
            Intent intent=new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,true);recognizer.startListening(intent);
        }catch(Exception e){onError(SpeechRecognizer.ERROR_CLIENT);}
    }
    private void destroyRecognizer(){SpeechRecognizer previous=recognizer;recognizer=null;if(previous!=null){previous.cancel();previous.destroy();}}
    void close(){accept=null;destroyRecognizer();if(dialog!=null){dialog.dismiss();dialog=null;}}
    private void result(Bundle value,boolean complete){if(dialog==null)return;ArrayList<String> lines=value.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);if(lines!=null&&!lines.isEmpty())transcript.setText(lines.get(0));if(complete){status.setText("请检查文字；填入草稿后仍需点击发送");dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(transcript.length()>0);dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setEnabled(false);destroyRecognizer();}}
    public void onResults(Bundle results){result(results,true);}
    public void onPartialResults(Bundle results){result(results,false);}
    public void onError(int error){if(dialog==null)return;status.setText(error==SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS?"麦克风权限未允许":error==SpeechRecognizer.ERROR_NO_MATCH||error==SpeechRecognizer.ERROR_SPEECH_TIMEOUT?"没有识别到语音，可取消后重试":"系统语音识别失败（"+error+"），可保留已有文字或取消");dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(transcript.length()>0);dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setEnabled(false);destroyRecognizer();}
    public void onReadyForSpeech(Bundle b){} public void onBeginningOfSpeech(){} public void onRmsChanged(float r){} public void onBufferReceived(byte[] b){} public void onEndOfSpeech(){if(dialog!=null)status.setText("正在识别…");} public void onEvent(int t,Bundle b){}
}
