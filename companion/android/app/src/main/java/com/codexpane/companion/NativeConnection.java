package com.codexpane.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.net.ConnectivityManager;
import android.net.Network;
import org.json.*;
import java.net.URI;
import java.security.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;
import okhttp3.*;

/** One serialized connection shared by the native UI and opt-in foreground service. */
final class NativeConnection {
    interface Listener { void changed(JSONObject event); }
    static synchronized NativeConnection get(Context context) { return NativeConnections.get(context).active(); }
    static JSONObject obj(Object... pairs) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < pairs.length; i += 2) result.put((String)pairs[i], pairs[i + 1]); }
        catch (JSONException error) { throw new IllegalArgumentException(error); }
        return result;
    }
    static void put(JSONObject value, String key, Object item) { try { value.put(key, item); } catch (JSONException error) { throw new IllegalArgumentException(error); } }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences preferences;
    final String computerId;
    final NativeLocalStore local;
    private final Context context;
    long lastSuccess,lastSnapshotAt;
    String lastFailure="", dnsState="未检测", relayState="未连接", authenticationState="未认证";
    private boolean reconciled, selectionRestored;
    private String bodyRequest="", bodyThread="", bodyCursor="";
    private boolean bodyStarted, bodyDone;
    int bodyRevision;
    private final Map<String,JSONArray> earlierItems=new HashMap<>();
    private final OkHttpClient client = new OkHttpClient.Builder().dns(new ResilientDns()).pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build();
    private final Set<Listener> listeners = new LinkedHashSet<>();
    private final Map<String, String> pending = new HashMap<>();
    private WebSocket socket;
    private ConnectivityManager.NetworkCallback networkCallback;
    private JSONObject binding, pairing, draft;
    private KeyPair signing, ephemeral;
    private byte[] sessionKey;
    private String sessionId = "";
    private long sendSequence, receiveSequence;
    private int generation, retry;
    private boolean stopped = true;
    boolean authenticated, visible;
    String status = "未连接", confirmation = "";
    JSONObject taskDetail=new JSONObject();
    String taskDetailRequest="";
    JSONObject snapshot = obj("threads", new JSONArray(), "items", new JSONArray());

    NativeConnection(Context context,String computerId) {
        this.context=context;this.computerId=computerId;
        preferences = context.getSharedPreferences("legacy".equals(computerId)?"native-device":"native-device-"+computerId, Context.MODE_PRIVATE);
        local=new NativeLocalStore(context,computerId);
        lastSuccess=preferences.getLong("lastSuccess",0);
        try { String raw = preferences.getString("binding", ""); if (!raw.isEmpty()) binding = new JSONObject(raw); }
        catch (Exception ignored) { status = "本机绑定记录无效，请重新配对"; }
        ConnectivityManager networks = context.getSystemService(ConnectivityManager.class);
        if (networks != null) {networkCallback=new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                main.post(() -> {
                    // Never restart a user-disconnected or security-rejected connection.
                    if (!stopped && binding != null && pairing == null) { retry = 0; reconnect(); }
                });
            }
        };networks.registerDefaultNetworkCallback(networkCallback);}
    }
    void dispose(){disconnect();ConnectivityManager networks=context.getSystemService(ConnectivityManager.class);if(networks!=null&&networkCallback!=null){try{networks.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}networkCallback=null;}}
    String name(){return preferences.getString("name","legacy".equals(computerId)?"工作电脑":"电脑 "+computerId.substring(0,Math.min(6,computerId.length())));}
    void name(String name){if(name.trim().isEmpty()||name.length()>80)throw new IllegalArgumentException("请输入 1–80 个字符");if(!preferences.edit().putString("name",name.trim()).commit())throw new IllegalStateException("无法保存名称");}
    boolean supports(String capability){JSONArray caps=snapshot.optJSONArray("capabilities");if(caps!=null)for(int i=0;i<caps.length();i++)if(capability.equals(caps.optString(i)))return true;return false;}
    void add(Listener listener) { listeners.add(listener); }
    void remove(Listener listener) { listeners.remove(listener); }
    boolean paired() { return binding != null; }
    boolean pairingActive() { return pairing != null; }
    boolean background() { return preferences.getBoolean("background", false); }
    void background(boolean enabled) { preferences.edit().putBoolean("background", enabled).apply(); }
    String relay() { return binding == null ? "" : binding.optString("relayOrigin"); }
    private void emit(JSONObject event) { put(event,"computerId",computerId); for (Listener listener : new ArrayList<>(listeners)) listener.changed(event); }
    private void state(String message) { status = message; emit(obj("type", "connection")); }
    private JSONObject jwk(PublicKey key) { return obj("crv", "P-256", "kty", "EC", "x", NativeCrypto.x(key), "y", NativeCrypto.y(key)); }
    private PublicKey publicKey(JSONObject key) throws Exception {
        if (key == null || !"EC".equals(key.optString("kty")) || !"P-256".equals(key.optString("crv"))) throw new SecurityException("桌面密钥格式无效");
        return NativeCrypto.publicKey(key.getString("x"), key.getString("y"));
    }
    private String canonical(JSONObject key) throws Exception { publicKey(key); return NativeCrypto.canonical(key.getString("x"), key.getString("y")); }

    void pair(String url) throws Exception {
        ConnectionUrl.validate(url);
        URI uri = new URI(url);
        String hash = uri.getRawFragment();
        if (hash == null || !hash.startsWith("pair=")) throw new IllegalArgumentException("请粘贴电脑生成的完整配对链接");
        JSONObject data = new JSONObject(new String(NativeCrypto.unb64(hash.substring(5)), StandardCharsets.UTF_8));
        String home = new URI(uri.getScheme(), null, uri.getHost(), uri.getPort(), uri.getPath(), null, null).toString().replaceAll("/+$", "");
        if (data.optInt("version") != 1 || data.optLong("expiresAt") < System.currentTimeMillis() || !home.equals(data.optString("relayOrigin"))) throw new SecurityException("配对链接过期或地址不匹配，请重新生成");
        if (data.getString("pairingSecret").length() < 32 || data.getString("pairingSecret").length() > 512) throw new SecurityException("配对密钥无效");
        UUID.fromString(data.getString("pairingId"));
        if (data.getString("channelId").isEmpty() || data.getString("channelId").length() > 200) throw new SecurityException("通道无效");
        publicKey(data.getJSONObject("desktopSigningPublicKey")); publicKey(data.getJSONObject("desktopAgreementPublicKey"));
        validatePairingComputer(data);
        disconnect();
        pairing = data;
        String deviceId = UUID.randomUUID().toString();
        signing = NativeIdentity.signing(deviceId);
        draft = obj("deviceId", deviceId, "deviceName", "Android 原生 · " + deviceId.substring(0, 6).toUpperCase(Locale.ROOT), "channelId", data.getString("channelId"), "relayOrigin", home, "desktopSigningPublicKey", data.getJSONObject("desktopSigningPublicKey"), "desktopAgreementPublicKey", data.getJSONObject("desktopAgreementPublicKey"));
        confirmation = "";
        stopped = false;
        connect();
    }
    void validatePairingComputer(JSONObject data)throws Exception {
        if(binding!=null&&(!binding.optString("channelId").equals(data.optString("channelId"))||!canonical(binding.getJSONObject("desktopSigningPublicKey")).equals(canonical(data.getJSONObject("desktopSigningPublicKey")))||!canonical(binding.getJSONObject("desktopAgreementPublicKey")).equals(canonical(data.getJSONObject("desktopAgreementPublicKey")))))throw new SecurityException("这是另一台电脑，请在我的电脑中添加电脑，原电脑数据不会迁移");
    }
    void resume() {
        if (socket != null || (binding == null && pairing == null)) return;
        stopped = false; connect();
    }
    void reconnect() { disconnect(); resume(); }
    void changeRelay(String address) throws Exception {
        if (binding == null || pairing != null) throw new IllegalStateException("请先完成设备绑定");
        String value = address.trim().replaceAll("/+$", "");
        ConnectionUrl.validate(value + "/");
        URI uri = new URI(value);
        if (uri.getRawFragment() != null) throw new IllegalArgumentException("请输入连接地址，不是配对链接");
        JSONObject updated = new JSONObject(binding.toString());
        updated.put("relayOrigin", value);
        // Keep pinned desktop keys and this device's identity. A different computer cannot authenticate.
        if (!preferences.edit().putString("binding", updated.toString()).commit()) throw new IllegalStateException("无法保存连接地址");
        disconnect(); binding = updated; retry = 0; resume();
    }
    void cancelPairing() {
        if (pairing == null) return;
        disconnect();
        if (draft != null) try { NativeIdentity.remove(draft.getString("deviceId")); } catch (Exception ignored) { }
        pairing = null; draft = null; confirmation = "";
        if (binding != null) resume();
    }
    void disconnect() {
        stopped = true; authenticated = false; generation++; sessionKey = null; markUncertain(); pending.clear();historyRequest="";historyLoaded=false;bodyRequest="";taskDetailRequest="";relayState="已断开";authenticationState="未认证";
        if (socket != null) { WebSocket previous = socket; socket = null; previous.close(1000, "User disconnect"); }
        state("已断开");
    }
    void forget() throws Exception {
        disconnect();
        if (binding != null) NativeIdentity.remove(binding.getString("deviceId"));
        if (!preferences.edit().remove("binding").commit()) throw new IllegalStateException("无法清除本机记录");
        preferences.edit().remove("background").remove("name").remove("lastSuccess").commit();local.clear();earlierItems.clear();
        clearHistory();binding = null; pairing = null; draft = null; confirmation = ""; snapshot = obj("threads", new JSONArray(), "items", new JSONArray());
        state("本机绑定已移除；桌面可另行撤销此设备");
    }
    private void connect() {
        if (stopped || socket != null) return;
        final int expected = ++generation;
        authenticated = false; sessionKey = null; reconciled=false;selectionRestored=false;authenticationState="等待认证";relayState="连接中";pending.clear(); sendSequence = receiveSequence = 0;
        JSONObject identity = pairing != null ? draft : binding;
        if (identity == null) { state("请先配对"); return; }
        try {
            if (pairing != null && pairing.getLong("expiresAt") < System.currentTimeMillis()) throw new SecurityException("配对链接已过期");
            signing = NativeIdentity.existing(identity.getString("deviceId"));
            String origin = identity.getString("relayOrigin");
            ConnectionUrl.validate(origin + "/");
            URI uri = new URI(origin);
            String webSocketUrl = ("https".equals(uri.getScheme()) ? "wss" : "ws") + origin.substring(origin.indexOf(':')) + "/ws";
            String headerOrigin = uri.getScheme() + "://" + uri.getRawAuthority();
            dnsState="解析与 TLS 连接中";state("正在连接…");
            socket = client.newWebSocket(new Request.Builder().url(webSocketUrl).header("Origin", headerOrigin).build(), new WebSocketListener() {
                @Override public void onMessage(WebSocket webSocket, String message) {
                    main.post(() -> {
                        if (expected != generation || webSocket != socket) return;
                        try { if (message.length() > 4 * 1024 * 1024) throw new SecurityException("消息过大"); handle(new JSONObject(message)); }
                        catch (Exception error) { receiveFailure(expected, error); }
                    });
                }
                @Override public void onClosed(WebSocket webSocket, int code, String reason) { main.post(() -> lost(expected, code, reason)); }
                @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(code, reason);
                    main.post(() -> lost(expected, code, reason));
                }
                @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                    android.util.Log.i("PaneFlowConnection", "Transport failed: " + error.getClass().getSimpleName());
                    main.post(() -> {lastFailure=error.getClass().getSimpleName();if(error instanceof java.net.UnknownHostException)dnsState="解析失败";lost(expected, 0, "");});
                }
            });
            main.postDelayed(() -> {
                if (expected == generation && !stopped && !authenticated && pairing == null && socket != null) socket.cancel();
            }, 30000);
        } catch (Exception error) { fatal("无法连接：" + safeError(error)); }
    }
    private String safeError(Exception error) {
        if (error instanceof SecurityException || error instanceof IllegalArgumentException) return error.getMessage() == null ? "数据无效" : error.getMessage();
        return error.getClass().getSimpleName();
    }
    private void fatal(String message) { lastFailure=message;authenticationState="校验失败";disconnect(); state(message); }
    private void lost(int expected, int code, String reason) {
        if (expected != generation || stopped) return;
        final int retryGeneration = ++generation;
        socket = null; authenticated = false; sessionKey = null; markUncertain();pending.clear();historyRequest="";historyLoaded=false;bodyRequest="";taskDetailRequest="";
        if (code == 1008 && !"Desktop offline".equals(reason)) { stopped = true; state("绑定被拒绝、撤销或配置不兼容，请检查电脑后重连或重新配对"); return; }
        relayState="已断开，等待重连";authenticationState="等待认证";if(lastFailure.isEmpty())lastFailure=code==1008?"电脑离线":"连接关闭（"+code+"）";state("连接中断，正在重连…");
        int delay = Math.min(30000, 1000 << Math.min(retry++, 5));
        main.postDelayed(() -> { if (!stopped && retryGeneration == generation) connect(); }, delay);
    }
    static final class TransportUnavailableException extends IllegalStateException { TransportUnavailableException(){super("连接已断开");} }
    void receiveFailure(int expected, Exception error) {
        if(expected!=generation||stopped)return;
        if(error instanceof TransportUnavailableException){lost(expected,0,"");return;}
        fatal("连接校验失败："+safeError(error));
    }
    private void frame(JSONObject value) throws Exception {
        if (socket == null || !socket.send(value.toString())) throw new TransportUnavailableException();
    }
    private void data(JSONObject value) throws Exception { frame(obj("type", "channel.data", "payload", value.toString())); }
    private JSONObject encrypt(JSONObject value) throws Exception {
        if (sessionKey == null) throw new SecurityException("安全会话未建立");
        byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
        long sequence = sendSequence++;
        return obj("type", "secure", "sessionId", sessionId, "sequence", sequence, "iv", NativeCrypto.b64(iv), "ciphertext", NativeCrypto.b64(NativeCrypto.crypt(true, sessionKey, sessionId, sequence, iv, NativeCrypto.utf8(value.toString()))));
    }
    private void secure(JSONObject value) throws Exception { data(encrypt(value)); }
    private JSONObject decrypt(JSONObject value) throws Exception {
        if (sessionKey == null || !sessionId.equals(value.getString("sessionId")) || value.getLong("sequence") != receiveSequence) throw new SecurityException("加密消息顺序无效");
        byte[] clear = NativeCrypto.crypt(false, sessionKey, sessionId, receiveSequence, NativeCrypto.unb64(value.getString("iv")), NativeCrypto.unb64(value.getString("ciphertext")));
        receiveSequence++;
        return new JSONObject(new String(clear, StandardCharsets.UTF_8));
    }
    private void handle(JSONObject message) throws Exception {
        String type = message.getString("type");
        JSONObject identity = pairing != null ? draft : binding;
        if ("relay.challenge".equals(type)) {
            dnsState="已连接到公网入口";relayState="中继已响应";android.util.Log.i("PaneFlowConnection", "Relay challenge received");
            if (message.getInt("protocolVersion") != 1 || message.getLong("expiresAt") < System.currentTimeMillis()) throw new SecurityException("中继挑战无效");
            if (pairing != null) frame(obj("type", "mobile.attach", "protocolVersion", 1, "mode", "pairing", "channelId", pairing.getString("channelId"), "pairingId", pairing.getString("pairingId"), "pairingSecret", pairing.getString("pairingSecret")));
            else {
                long now = System.currentTimeMillis();
                String proof = "mobile.attach\n1\n" + message.getString("connectionId") + "\n" + message.getString("nonce") + "\n" + binding.getString("channelId") + "\n" + binding.getString("deviceId") + "\n" + now;
                frame(obj("type", "mobile.attach", "protocolVersion", 1, "mode", "device", "channelId", binding.getString("channelId"), "deviceId", binding.getString("deviceId"), "timestamp", now, "signature", NativeCrypto.sign(signing.getPrivate(), proof)));
            }
        } else if ("relay.attached".equals(type)) {
            retry = 0; sessionId = UUID.randomUUID().toString(); ephemeral = NativeCrypto.ephemeral(); sendSequence = receiveSequence = 0;
            if (pairing != null) {
                String context = "pairing\n" + pairing.getString("channelId") + "\n" + pairing.getString("pairingId") + "\n" + sessionId;
                sessionKey = NativeCrypto.derive(ephemeral.getPrivate(), publicKey(pairing.getJSONObject("desktopAgreementPublicKey")), context);
                JSONObject hello = obj("type", "pairing.start", "authentication", "native", "pairingSecret", pairing.getString("pairingSecret"), "deviceId", draft.getString("deviceId"), "deviceName", draft.getString("deviceName"), "signingPublicKey", jwk(signing.getPublic()), "agreementPublicKey", jwk(ephemeral.getPublic()));
                data(obj("type", "pairing.hello", "sessionId", sessionId, "pairingId", pairing.getString("pairingId"), "mobileAgreementPublicKey", jwk(ephemeral.getPublic()), "envelope", encrypt(hello)));
            } else {
                long now = System.currentTimeMillis(); JSONObject key = jwk(ephemeral.getPublic());
                String proof = "session.hello\n" + binding.getString("channelId") + "\n" + sessionId + "\n" + binding.getString("deviceId") + "\n" + canonical(key) + "\n" + now;
                data(obj("type", "session.hello", "sessionId", sessionId, "deviceId", binding.getString("deviceId"), "mobileEphemeralPublicKey", key, "timestamp", now, "signature", NativeCrypto.sign(signing.getPrivate(), proof)));
            }
        } else if ("channel.data".equals(type)) {
            JSONObject payload = new JSONObject(message.getString("payload"));
            if ("session.welcome".equals(payload.optString("type"))) {
                long time = payload.getLong("timestamp");
                if (pairing != null || ephemeral == null || !sessionId.equals(payload.getString("sessionId")) || Math.abs(System.currentTimeMillis() - time) > 30000) throw new SecurityException("桌面握手无效");
                JSONObject remote = payload.getJSONObject("desktopEphemeralPublicKey");
                String proof = "session.welcome\n" + binding.getString("channelId") + "\n" + sessionId + "\n" + canonical(jwk(ephemeral.getPublic())) + "\n" + canonical(remote) + "\n" + time;
                if (!NativeCrypto.verify(publicKey(binding.getJSONObject("desktopSigningPublicKey")), proof, payload.getString("signature"))) throw new SecurityException("桌面身份不匹配");
                sessionKey = NativeCrypto.derive(ephemeral.getPrivate(), publicKey(remote), "session\n" + binding.getString("channelId") + "\n" + sessionId + "\n" + binding.getString("deviceId"));
            } else if ("secure".equals(payload.optString("type"))) handleSecure(decrypt(payload));
            else throw new SecurityException("拒绝未加密数据");
        } else if ("relay.notice".equals(type) && "desktop-offline".equals(message.optString("code"))) {put(snapshot,"deviceOnline",false);state("电脑离线，等待重新连接");}
    }
    private void handleSecure(JSONObject value) throws Exception {
        switch (value.getString("type")) {
            case "native.authentication.challenge":
                if (pairing != null || binding == null || authenticated) throw new SecurityException("身份挑战状态无效");
                String challenge = value.getString("challenge"); UUID.fromString(challenge);
                secure(obj("type", "native.authentication.response", "challenge", challenge)); break;
            case "pairing.awaiting-confirmation":
                confirmation = value.getString("code");
                if (!confirmation.matches("[0-9]{6}")) throw new SecurityException("确认码无效");
                state("核对以下数字，仅在电脑上确认原生设备绑定"); break;
            case "pairing.completed":
                if (pairing == null || draft == null || confirmation.isEmpty() || !draft.getString("deviceId").equals(value.getString("deviceId"))) throw new SecurityException("配对完成消息不匹配");
                if (!preferences.edit().putString("binding", draft.toString()).commit()) throw new IllegalStateException("保存设备绑定失败");
                clearHistory();snapshot=obj("threads",new JSONArray(),"items",new JSONArray());binding = draft; draft = null; pairing = null; confirmation = "";
                disconnect(); stopped = false;
                final int pairedGeneration = generation;
                final JSONObject pairedBinding = binding;
                main.postDelayed(() -> {
                    if (!stopped && generation == pairedGeneration && binding == pairedBinding && pairing == null && socket == null) connect();
                }, 150); break;
            case "session.ready":
                android.util.Log.i("PaneFlowConnection", "Device authenticated");
                if (binding == null || pairing != null) throw new SecurityException("会话身份无效");
                authenticated = true;authenticationState="电脑身份与设备认证通过";lastSuccess=System.currentTimeMillis();preferences.edit().putLong("lastSuccess",lastSuccess).apply(); state("已连接 · 原生设备认证"); command(obj("type", "snapshot.get")); break;
            case "desktop.event":
                if (!authenticated) throw new SecurityException("会话尚未认证");
                applyEvent(value.getJSONObject("event")); break;
            case "error": state(value.optString("message", "桌面拒绝了操作")); break;
            default: throw new SecurityException("桌面端不支持原生客户端，请更新配套端");
        }
    }
    private boolean tracked(String type){return !type.startsWith("attachment.")&&!Arrays.asList("snapshot.get","thread.list","thread.open","history.list","request.status","task.detail").contains(type);}
    void forgetAttachmentRequest(String id){String type=pending.get(id);if(type!=null&&type.startsWith("attachment."))pending.remove(id);}
    String command(JSONObject command) throws Exception {
        if (!authenticated) throw new IllegalStateException("尚未连接，请等待重连");
        if(!local.failure().isEmpty())throw new IllegalStateException(local.failure());
        String type=command.getString("type");
        if("thread.open".equals(type)&&!supports("independentSessions"))throw new IllegalStateException("电脑需升级至支持独立会话选择的版本");
        String requestId = command.optString("requestId",UUID.randomUUID().toString());UUID.fromString(requestId);put(command, "requestId", requestId);
        if (pending.size() >= 100) throw new IllegalStateException("仍有操作等待电脑响应");
        if(tracked(type)) {
            JSONObject records=new JSONObject(local.section("requests").toString());
            if(records.has(requestId))throw new IllegalStateException("该请求已记录，请先核对结果，不能重复执行");
            if(records.length()>=500){String oldest=null;long time=Long.MAX_VALUE;for(Iterator<String> it=records.keys();it.hasNext();){String id=it.next();JSONObject r=records.getJSONObject(id);if(Arrays.asList("completed","failed").contains(r.optString("status"))&&r.optLong("createdAt")<time){oldest=id;time=r.optLong("createdAt");}}if(oldest!=null)records.remove(oldest);else throw new IllegalStateException("未核对记录达到上限，请先核对并清理记录");}
            JSONObject record=obj("requestId",requestId,"type",type,"threadId",command.optString("threadId"),"status","waiting","createdAt",System.currentTimeMillis());
            if(command.has("text"))put(record,"text",command.getString("text"));
            if(command.has("attachmentIds"))put(record,"attachmentIds",command.getJSONArray("attachmentIds"));
            records.put(requestId,record);local.save("requests",records); // Write before any network side effect.
        }
        pending.put(requestId, type);
        try { secure(obj("type", "mobile.command", "command", command)); }
        catch (Exception error) { pending.remove(requestId);recordResult(requestId,"unknown","连接未确认请求结果");throw error; }
        return requestId;
    }
    private void markUncertain(){
        try{JSONObject records=new JSONObject(local.section("requests").toString());boolean changed=false;for(Iterator<String> it=records.keys();it.hasNext();){JSONObject r=records.optJSONObject(it.next());if(r!=null&&"waiting".equals(r.optString("status"))){r.put("status","unknown");changed=true;}}if(changed)local.save("requests",records);}catch(Exception e){lastFailure="本机请求记录保存失败";}
    }
    private void recordResult(String requestId,String status,String message)throws Exception {
        JSONObject records=new JSONObject(local.section("requests").toString());JSONObject record=records.optJSONObject(requestId);
        if(record==null)return;if(record.has("manualReviewedAt"))return;record.put("status",status);record.put("message",message);record.put("updatedAt",System.currentTimeMillis());local.save("requests",records);
    }
    void reconcile()throws Exception {
        if(!supports("requestStatus"))return;JSONArray ids=new JSONArray();JSONObject records=local.section("requests");
        for(Iterator<String> it=records.keys();it.hasNext();){String id=it.next();String state=records.getJSONObject(id).optString("status");if(!"completed".equals(state)&&!"failed".equals(state))ids.put(id);}
        // Batches bound wire size; querying never replays the original command.
        for(int offset=0;offset<ids.length();offset+=50){JSONArray batch=new JSONArray();for(int i=offset;i<Math.min(ids.length(),offset+50);i++)batch.put(ids.get(i));command(obj("type","request.status","requestIds",batch));}
    }
    JSONArray requests(String thread){JSONArray values=new JSONArray();JSONObject records=local.section("requests");for(Iterator<String> it=records.keys();it.hasNext();){JSONObject r=records.optJSONObject(it.next());if(r!=null&&(thread==null||thread.equals(r.optString("threadId"))))values.put(r);}return values;}
    void reviewUnknownRequest(String requestId,boolean completed)throws Exception {
        JSONObject records=new JSONObject(local.section("requests").toString());JSONObject record=records.optJSONObject(requestId);
        if(record==null||!"unknown".equals(record.optString("status")))throw new IllegalStateException("回执状态已变化，请刷新后重新核对");
        long now=System.currentTimeMillis();record.put("manualOriginalStatus","unknown");record.put("manualOriginalMessage",record.optString("message"));
        record.put("manualResolution",completed?"completed":"notExecuted");record.put("manualReviewedAt",now);record.put("manualComputerId",computerId);
        record.put("status",completed?"completed":"failed");record.put("updatedAt",now);local.save("requests",records);
    }
    void dismissRequest(String id)throws Exception {JSONObject records=new JSONObject(local.section("requests").toString());records.remove(id);local.save("requests",records);}
    static JSONArray mergeItems(JSONArray base,JSONArray incoming,boolean prepend) {
        ArrayList<String> order=new ArrayList<>();Map<String,JSONObject> values=new HashMap<>();
        if(base!=null)for(int i=0;i<base.length();i++){JSONObject item=base.optJSONObject(i);if(item==null)continue;String id=item.optString("id");if(!values.containsKey(id))order.add(id);values.put(id,item);}
        if(incoming!=null)for(int i=0;i<incoming.length();i++){
            JSONObject item=incoming.optJSONObject(i);if(item==null)continue;String id=item.optString("id");
            if(!values.containsKey(id)){int at=-1;for(int j=i+1;j<incoming.length();j++){JSONObject next=incoming.optJSONObject(j);if(next!=null){at=order.indexOf(next.optString("id"));if(at>=0)break;}}
                if(at<0)for(int j=i-1;j>=0;j--){JSONObject previous=incoming.optJSONObject(j);if(previous!=null){int prior=order.indexOf(previous.optString("id"));if(prior>=0){at=prior+1;break;}}}
                if(at<0)at=prepend?0:order.size();order.add(at,id);
            }values.put(id,item); // New history data replaces an older copy; live snapshot wins when merged last.
        }
        JSONArray result=new JSONArray();for(String id:order)result.put(values.get(id));return result;
    }
    JSONArray chatItems(){String thread=snapshot.optString("activeThreadId","");return mergeItems(earlierItems.get(thread),snapshot.optJSONArray("items"),false);}
    boolean bodyComplete(){return bodyDone;}
    String bodyLabel(){if(!supports("historyPagination"))return "电脑需升级后才能加载更早历史";if(!bodyRequest.isEmpty())return "正在加载历史…";return bodyDone?"已到会话开头":"加载更早的消息";}
    boolean bodyLoading(){return !bodyRequest.isEmpty();}
    void loadEarlier()throws Exception {
        if(!supports("historyPagination"))throw new IllegalStateException("电脑需升级后才能加载更早历史");
        String thread=snapshot.optString("activeThreadId","");if(thread.isEmpty()||"null".equals(thread))return;
        if(!thread.equals(bodyThread)){bodyThread=thread;bodyCursor="";bodyStarted=false;bodyDone=false;bodyRequest="";}
        if(!bodyRequest.isEmpty()||bodyDone)return;
        JSONObject request=obj("type","history.list","threadId",thread,"limit",20);if(bodyStarted&&!bodyCursor.isEmpty())put(request,"cursor",bodyCursor);bodyRequest=command(request);
    }
    JSONObject diagnostics(){return obj("version",1,"computer",name(),"entry",relay().isEmpty()?"未配置":relay().startsWith("https://")?"HTTPS 入口已配置":"本地测试入口已配置","dns",authenticated?dnsState:"当前未确认；最后观测："+dnsState,"relay",relayState,"desktop",authenticated&&snapshot.optBoolean("deviceOnline",false)?"在线":"当前未知或离线","authentication",authenticationState,"lastSuccess",lastSuccess,"lastFailure",lastFailure,"background",background(),"pendingRequests",requests(null).length(),"localStorage",local.failure().isEmpty()?"已加密":"读取失败");}
    private void upsert(JSONArray array, JSONObject item) throws Exception {
        for (int i = 0; i < array.length(); i++) if (item.getString("id").equals(array.getJSONObject(i).optString("id"))) { array.put(i, item); return; }
        if (array.length() >= 1000) array.remove(0);
        array.put(item);
    }
    JSONArray historyThreads=new JSONArray();
    String historyCursor="",historyRequest="",historyQuery="";
    boolean historyLoaded=false,historyReset=false;
    void clearHistory(){historyThreads=new JSONArray();historyCursor="";historyRequest="";historyQuery="";historyLoaded=false;}
    void invalidateHistory(String query){clearHistory();historyQuery=query;}
    void requestHistory(boolean reset,String query) throws Exception {
        if(!query.equals(historyQuery))reset=true;
        if(!reset&&(!historyRequest.isEmpty()||historyCursor.isEmpty()))return;
        if(reset){invalidateHistory(query);historyLoaded=true;}
        JSONObject request=obj("type","thread.list","limit",reset?5:10,"searchTerm",query);
        if(!reset)put(request,"cursor",historyCursor);
        historyReset=reset;historyQuery=query;historyRequest=command(request);
    }
    void requestTaskDetail(String taskId,String threadId)throws Exception {if(!supports("taskDetails"))throw new IllegalStateException("电脑需升级后才能查看任务详情");JSONObject request=obj("type","task.detail");if(!taskId.isEmpty())put(request,"taskId",taskId);else put(request,"threadId",threadId);taskDetail=new JSONObject();taskDetailRequest=command(request);}
    private void rememberUnavailableAttachments(String thread,JSONArray items)throws Exception {
        if(thread.isEmpty()||"null".equals(thread)||items==null)return;
        JSONObject deleted=new JSONObject(local.section("attachmentDeleted").toString());boolean changed=false;
        for(int i=0;i<items.length();i++){
            JSONObject item=items.optJSONObject(i);JSONArray attachments=item==null?null:item.optJSONArray("attachments");if(attachments==null)continue;
            for(int j=0;j<attachments.length();j++){
                JSONObject attachment=attachments.optJSONObject(j);if(attachment==null||!Boolean.FALSE.equals(attachment.opt("available")))continue;
                String id=attachment.optString("id");try{UUID.fromString(id);}catch(IllegalArgumentException invalid){continue;}
                String key=thread+":"+id;if(!"true".equals(deleted.optString(key))){deleted.put(key,"true");changed=true;}
            }
        }
        // Deletion is monotonic: a stale available:true projection cannot erase this evidence.
        // Persist before rendering or any later cache cleanup, including after a lost delete ack.
        if(changed)local.save("attachmentDeleted",deleted);
    }
    private void applyEvent(JSONObject event) throws Exception {
        String type = event.getString("type");
        if(type.startsWith("attachment."))pending.remove(event.optString("requestId"));
        if("snapshot".equals(type)){JSONObject incoming=event.getJSONObject("snapshot");rememberUnavailableAttachments(incoming.optString("activeThreadId"),incoming.optJSONArray("items"));}
        else if("history.page".equals(type))rememberUnavailableAttachments(event.optString("threadId"),event.optJSONArray("items"));
        else if("item.upsert".equals(type))rememberUnavailableAttachments(event.optString("threadId"),new JSONArray().put(event.getJSONObject("item")));
        String active = snapshot.optString("activeThreadId", "");
        if ("thread.page".equals(type) && historyRequest.equals(event.optString("requestId"))) {
            if(historyReset)historyThreads=new JSONArray();
            JSONArray page=event.getJSONArray("threads");
            for(int i=0;i<page.length();i++)upsert(historyThreads,page.getJSONObject(i));
            historyCursor=event.isNull("nextCursor")?"":event.optString("nextCursor","");
            historyLoaded=true;historyRequest="";
        }
        else if ("snapshot".equals(type)) {
            snapshot = event.getJSONObject("snapshot");lastSnapshotAt=System.currentTimeMillis();
            if(!reconciled){reconciled=true;reconcile();}
            String selected=snapshot.optString("activeThreadId","");
            boolean restoring=false;if(!selectionRestored){selectionRestored=true;String saved=local.text("selection","thread");if(!saved.isEmpty()&&!saved.equals(selected)&&supports("independentSessions")){restoring=true;command(obj("type","thread.open","threadId",saved));}}
            if(!restoring&&!selected.isEmpty()&&!"null".equals(selected))local.text("selection","thread",selected);
            if(!selected.equals(bodyThread)){bodyThread=selected;bodyStarted=false;bodyDone=false;bodyCursor="";bodyRequest="";}
        }
        else if("task.detail".equals(type)&&taskDetailRequest.equals(event.optString("requestId"))){taskDetail=event.getJSONObject("detail");taskDetailRequest="";pending.remove(event.optString("requestId"));}
        else if("request.status".equals(type)) {
            pending.remove(event.optString("requestId"));JSONArray records=event.optJSONArray("records");if(records!=null)for(int i=0;i<records.length();i++){JSONObject r=records.optJSONObject(i);if(r!=null){recordResult(r.optString("requestId"),r.optString("status","unknown"),r.optString("message"));JSONObject recordsCopy=new JSONObject(local.section("requests").toString());JSONObject stored=recordsCopy.optJSONObject(r.optString("requestId"));if(stored!=null){if(r.has("threadId"))stored.put("threadId",r.getString("threadId"));if(r.has("turnId"))stored.put("turnId",r.getString("turnId"));local.save("requests",recordsCopy);}}}
        }
        else if("history.page".equals(type)&&bodyRequest.equals(event.optString("requestId"))&&bodyThread.equals(event.optString("threadId"))) {
            JSONArray page=event.optJSONArray("items"),old=earlierItems.get(bodyThread);earlierItems.put(bodyThread,mergeItems(old,page,true));
            bodyCursor=event.isNull("nextCursor")?"":event.optString("nextCursor");bodyStarted=true;bodyDone=bodyCursor.isEmpty();bodyRequest="";bodyRevision++;
        }
        else if ("thread.summary".equals(type)) upsert(snapshot.getJSONArray("threads"), event.getJSONObject("thread"));
        else if ("item.upsert".equals(type) && active.equals(event.optString("threadId"))) upsert(snapshot.getJSONArray("items"), event.getJSONObject("item"));
        else if ("approval.request".equals(type) && active.equals(event.optString("threadId"))) upsert(snapshot.getJSONArray("items"), event.getJSONObject("approval"));
        else if ("turn.status".equals(type) && active.equals(event.optString("threadId"))) {
            put(snapshot, "turnStatus", event.getString("status"));
            if ("idle".equals(event.optString("status")) || "failed".equals(event.optString("status"))) put(snapshot, "activeTurnId", JSONObject.NULL);
        } else if ("device.status".equals(type)) { put(snapshot, "deviceOnline", event.optBoolean("online")); put(snapshot, "codexState", event.optString("codexState")); }
        else if ("command.result".equals(type)) {
            String commandType = pending.remove(event.optString("requestId"));
            recordResult(event.optString("requestId"),event.optBoolean("ok")?"completed":"unknown",event.optString("message"));
            if(bodyRequest.equals(event.optString("requestId"))&&!event.optBoolean("ok"))bodyRequest="";
            if(taskDetailRequest.equals(event.optString("requestId"))&&!event.optBoolean("ok"))taskDetailRequest="";
            if(historyRequest.equals(event.optString("requestId"))&&!event.optBoolean("ok"))historyRequest="";
            if (!event.optBoolean("ok")) state(event.optString("message", "操作未完成"));
            else if (commandType != null && !commandType.startsWith("attachment.") && !commandType.equals("snapshot.get") && !commandType.equals("thread.list") && !commandType.equals("request.status") && !commandType.equals("history.list") && !commandType.equals("task.detail")) command(obj("type", "snapshot.get"));
        } else if ("desktop.required".equals(type) || "notice".equals(type)) state(event.optString("message"));
        emit(event);
    }
}
