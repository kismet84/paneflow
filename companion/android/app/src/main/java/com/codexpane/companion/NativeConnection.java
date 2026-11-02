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
    private static NativeConnection instance;
    static synchronized NativeConnection get(Context context) {
        if (instance == null) instance = new NativeConnection(context.getApplicationContext());
        return instance;
    }
    static JSONObject obj(Object... pairs) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < pairs.length; i += 2) result.put((String)pairs[i], pairs[i + 1]); }
        catch (JSONException error) { throw new IllegalArgumentException(error); }
        return result;
    }
    static void put(JSONObject value, String key, Object item) { try { value.put(key, item); } catch (JSONException error) { throw new IllegalArgumentException(error); } }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences preferences;
    private final OkHttpClient client = new OkHttpClient.Builder().dns(new ResilientDns()).pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build();
    private final Set<Listener> listeners = new LinkedHashSet<>();
    private final Map<String, String> pending = new HashMap<>();
    private WebSocket socket;
    private JSONObject binding, pairing, draft;
    private KeyPair signing, ephemeral;
    private byte[] sessionKey;
    private String sessionId = "";
    private long sendSequence, receiveSequence;
    private int generation, retry;
    private boolean stopped = true;
    boolean authenticated, visible;
    String status = "未连接", confirmation = "";
    JSONObject snapshot = obj("threads", new JSONArray(), "items", new JSONArray());

    private NativeConnection(Context context) {
        preferences = context.getSharedPreferences("native-device", Context.MODE_PRIVATE);
        try { String raw = preferences.getString("binding", ""); if (!raw.isEmpty()) binding = new JSONObject(raw); }
        catch (Exception ignored) { status = "本机绑定记录无效，请重新配对"; }
        ConnectivityManager networks = context.getSystemService(ConnectivityManager.class);
        if (networks != null) networks.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                main.post(() -> {
                    // Never restart a user-disconnected or security-rejected connection.
                    if (!stopped && binding != null && pairing == null) { retry = 0; reconnect(); }
                });
            }
        });
    }
    void add(Listener listener) { listeners.add(listener); }
    void remove(Listener listener) { listeners.remove(listener); }
    boolean paired() { return binding != null; }
    boolean pairingActive() { return pairing != null; }
    boolean background() { return preferences.getBoolean("background", false); }
    void background(boolean enabled) { preferences.edit().putBoolean("background", enabled).apply(); }
    String relay() { return binding == null ? "" : binding.optString("relayOrigin"); }
    private void emit(JSONObject event) { for (Listener listener : new ArrayList<>(listeners)) listener.changed(event); }
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
        disconnect();
        pairing = data;
        String deviceId = UUID.randomUUID().toString();
        signing = NativeIdentity.signing(deviceId);
        draft = obj("deviceId", deviceId, "deviceName", "Android 原生 · " + deviceId.substring(0, 6).toUpperCase(Locale.ROOT), "channelId", data.getString("channelId"), "relayOrigin", home, "desktopSigningPublicKey", data.getJSONObject("desktopSigningPublicKey"), "desktopAgreementPublicKey", data.getJSONObject("desktopAgreementPublicKey"));
        confirmation = "";
        stopped = false;
        connect();
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
        stopped = true; authenticated = false; generation++; sessionKey = null; pending.clear();historyRequest="";historyLoaded=false;
        if (socket != null) { WebSocket previous = socket; socket = null; previous.close(1000, "User disconnect"); }
        state("已断开");
    }
    void forget() throws Exception {
        disconnect();
        if (binding != null) NativeIdentity.remove(binding.getString("deviceId"));
        if (!preferences.edit().remove("binding").commit()) throw new IllegalStateException("无法清除本机记录");
        clearHistory();binding = null; pairing = null; draft = null; confirmation = ""; snapshot = obj("threads", new JSONArray(), "items", new JSONArray());
        state("本机绑定已移除；桌面可另行撤销此设备");
    }
    private void connect() {
        if (stopped || socket != null) return;
        final int expected = ++generation;
        authenticated = false; sessionKey = null; pending.clear(); sendSequence = receiveSequence = 0;
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
            state("正在连接…");
            socket = client.newWebSocket(new Request.Builder().url(webSocketUrl).header("Origin", headerOrigin).build(), new WebSocketListener() {
                @Override public void onMessage(WebSocket webSocket, String message) {
                    main.post(() -> {
                        if (expected != generation || webSocket != socket) return;
                        try { if (message.length() > 4 * 1024 * 1024) throw new SecurityException("消息过大"); handle(new JSONObject(message)); }
                        catch (Exception error) { fatal("连接校验失败：" + safeError(error)); }
                    });
                }
                @Override public void onClosed(WebSocket webSocket, int code, String reason) { main.post(() -> lost(expected, code, reason)); }
                @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(code, reason);
                    main.post(() -> lost(expected, code, reason));
                }
                @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                    android.util.Log.i("PaneFlowConnection", "Transport failed: " + error.getClass().getSimpleName());
                    main.post(() -> lost(expected, 0, ""));
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
    private void fatal(String message) { disconnect(); state(message); }
    private void lost(int expected, int code, String reason) {
        if (expected != generation || stopped) return;
        final int retryGeneration = ++generation;
        socket = null; authenticated = false; sessionKey = null; pending.clear();historyRequest="";historyLoaded=false;
        if (code == 1008 && !"Desktop offline".equals(reason)) { stopped = true; state("绑定被拒绝、撤销或配置不兼容，请检查电脑后重连或重新配对"); return; }
        state("连接中断，正在重连…");
        int delay = Math.min(30000, 1000 << Math.min(retry++, 5));
        main.postDelayed(() -> { if (!stopped && retryGeneration == generation) connect(); }, delay);
    }
    private void frame(JSONObject value) throws Exception {
        if (socket == null || !socket.send(value.toString())) throw new IllegalStateException("连接已断开");
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
            android.util.Log.i("PaneFlowConnection", "Relay challenge received");
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
        } else if ("relay.notice".equals(type) && "desktop-offline".equals(message.optString("code"))) state("电脑离线，等待重新连接");
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
                authenticated = true; state("已连接 · 原生设备认证"); command(obj("type", "snapshot.get")); break;
            case "desktop.event":
                if (!authenticated) throw new SecurityException("会话尚未认证");
                applyEvent(value.getJSONObject("event")); break;
            case "error": state(value.optString("message", "桌面拒绝了操作")); break;
            default: throw new SecurityException("桌面端不支持原生客户端，请更新配套端");
        }
    }
    String command(JSONObject command) throws Exception {
        if (!authenticated) throw new IllegalStateException("尚未连接，请等待重连");
        String requestId = UUID.randomUUID().toString(); put(command, "requestId", requestId);
        if (pending.size() >= 100) throw new IllegalStateException("仍有操作等待电脑响应");
        pending.put(requestId, command.getString("type"));
        try { secure(obj("type", "mobile.command", "command", command)); }
        catch (Exception error) { pending.remove(requestId); throw error; }
        return requestId;
    }
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
    private void applyEvent(JSONObject event) throws Exception {
        String type = event.getString("type");
        String active = snapshot.optString("activeThreadId", "");
        if ("thread.page".equals(type) && historyRequest.equals(event.optString("requestId"))) {
            if(historyReset)historyThreads=new JSONArray();
            JSONArray page=event.getJSONArray("threads");
            for(int i=0;i<page.length();i++)upsert(historyThreads,page.getJSONObject(i));
            historyCursor=event.isNull("nextCursor")?"":event.optString("nextCursor","");
            historyLoaded=true;historyRequest="";
        }
        else if ("snapshot".equals(type)) snapshot = event.getJSONObject("snapshot");
        else if ("thread.summary".equals(type)) upsert(snapshot.getJSONArray("threads"), event.getJSONObject("thread"));
        else if ("item.upsert".equals(type) && active.equals(event.optString("threadId"))) upsert(snapshot.getJSONArray("items"), event.getJSONObject("item"));
        else if ("approval.request".equals(type) && active.equals(event.optString("threadId"))) upsert(snapshot.getJSONArray("items"), event.getJSONObject("approval"));
        else if ("turn.status".equals(type) && active.equals(event.optString("threadId"))) {
            put(snapshot, "turnStatus", event.getString("status"));
            if ("idle".equals(event.optString("status")) || "failed".equals(event.optString("status"))) put(snapshot, "activeTurnId", JSONObject.NULL);
        } else if ("device.status".equals(type)) { put(snapshot, "deviceOnline", event.optBoolean("online")); put(snapshot, "codexState", event.optString("codexState")); }
        else if ("command.result".equals(type)) {
            String commandType = pending.remove(event.optString("requestId"));
            if(historyRequest.equals(event.optString("requestId"))&&!event.optBoolean("ok"))historyRequest="";
            if (!event.optBoolean("ok")) state(event.optString("message", "操作未完成"));
            else if (commandType != null && !commandType.equals("snapshot.get") && !commandType.equals("thread.list")) command(obj("type", "snapshot.get"));
        } else if ("desktop.required".equals(type) || "notice".equals(type)) state(event.optString("message"));
        emit(event);
    }
}
