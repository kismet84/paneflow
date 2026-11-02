const encoder = new TextEncoder();
const decoder = new TextDecoder();
const statusElement = document.querySelector("#status");
const actionsElement = document.querySelector("#actions");
const errorElement = document.querySelector("#error");
const bootstrapRoot = document.querySelector("#bootstrap");
const bootstrapScriptUrl = new URL(import.meta.url);
const relayBasePath = bootstrapScriptUrl.pathname.slice(0, -"/bootstrap.js".length).replace(/\/+$/, "");
const relayUrl = `${location.origin}${relayBasePath}`;
const relayHomePath = `${relayBasePath}/`;

const setStatus = (value) => { statusElement.textContent = value; };
const setError = (value = "") => { errorElement.textContent = value; errorElement.hidden = !value; };
const setActions = (...buttons) => { actionsElement.replaceChildren(...buttons); };
const button = (label, action, secondary = false) => {
  const element = document.createElement("button");
  element.textContent = label;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", action);
  return element;
};
const toBase64Url = (value) => {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const fromBase64Url = (value) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};
const canonicalJwk = (key) => JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
const mobileAttachProof = (connectionId, nonce, channelId, deviceId, timestamp) => `mobile.attach\n1\n${connectionId}\n${nonce}\n${channelId}\n${deviceId}\n${timestamp}`;
const sessionHelloProof = (channelId, sessionId, deviceId, key, timestamp) => `session.hello\n${channelId}\n${sessionId}\n${deviceId}\n${canonicalJwk(key)}\n${timestamp}`;
const sessionWelcomeProof = (channelId, sessionId, mobileKey, desktopKey, timestamp) => `session.welcome\n${channelId}\n${sessionId}\n${canonicalJwk(mobileKey)}\n${canonicalJwk(desktopKey)}\n${timestamp}`;
const uiDocumentProof = (version, hash) => `ui.document\n1\n${version}\n${hash}`;
const sha256 = async (value) => toBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("codex-pane-remote-bootstrap", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("bindings", { keyPath: "channelId" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const databaseOperation = async (mode, operation) => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("bindings", mode);
      const request = operation(transaction.objectStore("bindings"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
};
const listBindings = () => databaseOperation("readonly", (store) => store.getAll());
const saveBinding = (binding) => databaseOperation("readwrite", (store) => store.put(binding));
const deleteBinding = (channelId) => databaseOperation("readwrite", (store) => store.delete(channelId));

const generateStoredKeyPair = async (name, usages) => {
  const generated = await crypto.subtle.generateKey({ name, namedCurve: "P-256" }, true, usages);
  const publicKey = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name, namedCurve: "P-256" }, false, usages.filter((usage) => usage !== "verify"));
  return { publicKey, privateKey };
};
const importPublicKey = (name, key, usages) => crypto.subtle.importKey("jwk", key, { name, namedCurve: "P-256" }, true, usages);
const signProof = async (privateKey, value) => toBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(value)));
const verifyProof = async (publicKey, value, signature) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64Url(signature), encoder.encode(value));
const deriveKey = async (privateKey, publicJwk, context) => {
  const publicKey = await importPublicKey("ECDH", publicJwk, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(context), info: encoder.encode("codex-pane-remote-v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
};

class SecureSession {
  constructor(sessionId, key) { this.sessionId = sessionId; this.key = key; this.sendSequence = 0; this.receiveSequence = 0; }
  aad(sequence) { return encoder.encode(`codex-pane-secure-v1\n${this.sessionId}\n${sequence}`); }
  async encrypt(payload) {
    const sequence = this.sendSequence++;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad(sequence) }, this.key, encoder.encode(JSON.stringify(payload)));
    return { type: "secure", sessionId: this.sessionId, sequence, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
  }
  async decrypt(envelope) {
    if (envelope.type !== "secure" || envelope.sessionId !== this.sessionId || envelope.sequence !== this.receiveSequence) throw new Error("收到的加密消息顺序无效。");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: this.aad(envelope.sequence) }, this.key, fromBase64Url(envelope.ciphertext));
    this.receiveSequence += 1;
    return JSON.parse(decoder.decode(plaintext));
  }
}

const credentialCreationOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  user: { ...options.user, id: fromBase64Url(options.user.id) },
  excludeCredentials: (options.excludeCredentials ?? []).map((item) => ({ ...item, id: fromBase64Url(item.id) }))
});
const credentialRequestOptions = (options) => ({
  ...options,
  challenge: fromBase64Url(options.challenge),
  allowCredentials: (options.allowCredentials ?? []).map((item) => ({ ...item, id: fromBase64Url(item.id) }))
});
const serializeRegistration = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  response: { clientDataJSON: toBase64Url(credential.response.clientDataJSON), attestationObject: toBase64Url(credential.response.attestationObject), transports: credential.response.getTransports?.() ?? [] },
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  authenticatorAttachment: credential.authenticatorAttachment
});
const serializeAuthentication = (credential) => ({
  id: credential.id,
  rawId: toBase64Url(credential.rawId),
  response: {
    clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    authenticatorData: toBase64Url(credential.response.authenticatorData),
    signature: toBase64Url(credential.response.signature),
    userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : undefined
  },
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  authenticatorAttachment: credential.authenticatorAttachment
});

let socket = null;
let secure = null;
let activeBinding = null;
let pairing = null;
let pairingDraft = null;
let ephemeral = null;
let iframe = null;
let uiReady = false;
let messageQueue = Promise.resolve();
let secureSendQueue = Promise.resolve();
let reconnectAttempt = 0;
let stopped = false;
let uiLoadTimer = null;
const queuedUiEvents = [];

const clearUiLoadTimer = () => {
  if (uiLoadTimer === null) return;
  window.clearTimeout(uiLoadTimer);
  uiLoadTimer = null;
};

const sendFrame = (value) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("与中转服务的连接尚未恢复。");
  socket.send(JSON.stringify(value));
};
const sendData = (value) => sendFrame({ type: "channel.data", payload: JSON.stringify(value) });
const sendSecure = (value) => {
  const session = secure;
  const connection = socket;
  const operation = secureSendQueue.then(async () => {
    if (!session || secure !== session || !connection || socket !== connection) throw new Error("与桌面端的安全连接尚未恢复。");
    const envelope = await session.encrypt(value);
    if (secure !== session || socket !== connection) throw new Error("与桌面端的安全连接已更新，请重试。");
    sendData(envelope);
  });
  secureSendQueue = operation.catch(() => undefined);
  return operation;
};
const parsePairing = () => {
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (!encoded) return null;
    const value = JSON.parse(decoder.decode(fromBase64Url(encoded)));
    if (value.version !== 1 || value.relayOrigin !== relayUrl || value.expiresAt < Date.now()) throw new Error("二维码已经过期，请在桌面端重新生成。");
    return value;
  } catch (error) {
    setError(error instanceof Error ? error.message : "配对二维码无效。");
    return null;
  }
};

const beginPairing = async () => {
  const deviceId = crypto.randomUUID();
  const deviceType = /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone / iPad" : /Android/i.test(navigator.userAgent) ? "Android 手机" : "手机浏览器";
  pairingDraft = {
    channelId: pairing.channelId,
    deviceId,
    deviceName: `${deviceType} · ${deviceId.slice(0, 6).toUpperCase()}`,
    signing: await generateStoredKeyPair("ECDSA", ["sign", "verify"]),
    agreement: await generateStoredKeyPair("ECDH", ["deriveBits"]),
    desktopSigningPublicKey: pairing.desktopSigningPublicKey,
    desktopAgreementPublicKey: pairing.desktopAgreementPublicKey,
    passkeyId: ""
  };
  connect();
};

const connect = () => {
  stopped = false;
  secure = null;
  clearUiLoadTimer();
  if (iframe) {
    iframe = null;
    uiReady = false;
    queuedUiEvents.length = 0;
    document.body.replaceChildren(bootstrapRoot);
  }
  setActions();
  setError();
  setStatus("正在连接桌面端…");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}${relayBasePath}/ws`);
  messageQueue = Promise.resolve();
  secureSendQueue = Promise.resolve();
  socket.onmessage = (event) => {
    messageQueue = messageQueue
      .then(() => handleRelayMessage(JSON.parse(String(event.data))))
      .catch((error) => setError(error instanceof Error ? error.message : "远程连接发生错误。"));
  };
  socket.onclose = (event) => {
    socket = null;
    secure = null;
    if (stopped) return;
    if (uiReady && iframe?.contentWindow) iframe.contentWindow.postMessage({ source: "codex-pane-bootstrap", type: "disconnected", message: "与桌面端的安全连接已断开" }, "*");
    if (event.code === 1008 && (event.reason === "Access removed" || event.reason === "Access denied")) {
      stopped = true;
      if (activeBinding) void deleteBinding(activeBinding.channelId);
      iframe = null;
      document.body.replaceChildren(bootstrapRoot);
      setStatus("这部手机的绑定已失效，请在桌面端重新生成二维码。");
      setActions();
      return;
    }
    if (event.code === 1008 && (event.reason === "Pairing rejected" || event.reason === "Pairing replaced")) {
      stopped = true;
      setStatus(event.reason === "Pairing replaced" ? "配对已在另一个页面继续，请关闭此页面。" : "配对信息已失效，请在桌面端重新生成二维码。");
      setActions();
      return;
    }
    if (event.code === 1008 && event.reason === "Origin rejected") {
      stopped = true;
      setStatus("中转服务配置错误，请检查 PUBLIC_ORIGIN。");
      setActions();
      return;
    }
    setStatus("连接中断，正在重试…");
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt) + Math.random() * 500;
    reconnectAttempt += 1;
    window.setTimeout(connect, delay);
  };
  socket.onerror = () => setStatus("网络连接异常，正在重试…");
};

const handleRelayMessage = async (message) => {
  if (message.type === "relay.notice" && message.code === "desktop-offline") { setStatus("桌面端未连接"); return; }
  if (message.type === "relay.challenge") {
    if (pairing) {
      sendFrame({ type: "mobile.attach", protocolVersion: 1, mode: "pairing", channelId: pairing.channelId, pairingId: pairing.pairingId, pairingSecret: pairing.pairingSecret });
      return;
    }
    const timestamp = Date.now();
    const proof = mobileAttachProof(message.connectionId, message.nonce, activeBinding.channelId, activeBinding.deviceId, timestamp);
    sendFrame({ type: "mobile.attach", protocolVersion: 1, mode: "device", channelId: activeBinding.channelId, deviceId: activeBinding.deviceId, timestamp, signature: await signProof(activeBinding.signingPrivateKey, proof) });
    return;
  }
  if (message.type === "relay.attached" && message.role === "mobile") {
    reconnectAttempt = 0;
    if (pairing) await startPairingHandshake();
    else await startSessionHandshake();
    return;
  }
  if (message.type === "channel.data") await handlePeerPayload(JSON.parse(message.payload));
};

const startPairingHandshake = async () => {
  const sessionId = crypto.randomUUID();
  const context = `pairing\n${pairing.channelId}\n${pairing.pairingId}\n${sessionId}`;
  secure = new SecureSession(sessionId, await deriveKey(pairingDraft.agreement.privateKey, pairing.desktopAgreementPublicKey, context));
  const envelope = await secure.encrypt({ type: "pairing.start", pairingSecret: pairing.pairingSecret, deviceId: pairingDraft.deviceId, deviceName: pairingDraft.deviceName, signingPublicKey: pairingDraft.signing.publicKey, agreementPublicKey: pairingDraft.agreement.publicKey });
  sendData({ type: "pairing.hello", sessionId, pairingId: pairing.pairingId, mobileAgreementPublicKey: pairingDraft.agreement.publicKey, envelope });
  setStatus("正在准备 Passkey 登记…");
};

const startSessionHandshake = async () => {
  const sessionId = crypto.randomUUID();
  ephemeral = await generateStoredKeyPair("ECDH", ["deriveBits"]);
  const timestamp = Date.now();
  const proof = sessionHelloProof(activeBinding.channelId, sessionId, activeBinding.deviceId, ephemeral.publicKey, timestamp);
  sendData({ type: "session.hello", sessionId, deviceId: activeBinding.deviceId, mobileEphemeralPublicKey: ephemeral.publicKey, timestamp, signature: await signProof(activeBinding.signingPrivateKey, proof) });
  setStatus("正在验证桌面和手机身份…");
};

const handlePeerPayload = async (payload) => {
  if (payload.type === "session.welcome") {
    if (!activeBinding || !ephemeral || Math.abs(Date.now() - payload.timestamp) > 30_000) throw new Error("桌面身份响应无效。");
    const publicKey = await importPublicKey("ECDSA", activeBinding.desktopSigningPublicKey, ["verify"]);
    const proof = sessionWelcomeProof(activeBinding.channelId, payload.sessionId, ephemeral.publicKey, payload.desktopEphemeralPublicKey, payload.timestamp);
    if (!await verifyProof(publicKey, proof, payload.signature)) throw new Error("无法确认桌面端身份。");
    const context = `session\n${activeBinding.channelId}\n${payload.sessionId}\n${activeBinding.deviceId}`;
    secure = new SecureSession(payload.sessionId, await deriveKey(ephemeral.privateKey, payload.desktopEphemeralPublicKey, context));
    return;
  }
  if (payload.type !== "secure" || !secure) throw new Error("桌面端发送了未加密消息。");
  await handleSecureMessage(await secure.decrypt(payload));
};

const handleSecureMessage = async (message) => {
  if (message.type === "passkey.registration.options") {
    setStatus("完成身份验证后即可绑定这部手机");
    setActions(button("创建 Passkey", async (event) => {
      const actionButton = event.currentTarget;
      actionButton.disabled = true;
      try {
        const credential = await navigator.credentials.create({ publicKey: credentialCreationOptions(message.options) });
        if (!credential) throw new Error("Passkey 创建已取消。");
        pairingDraft.passkeyId = credential.id;
        await sendSecure({ type: "passkey.registration.response", name: pairingDraft.deviceName, response: serializeRegistration(credential) });
        setStatus("请核对手机与桌面的确认码");
      } catch (error) {
        actionButton.disabled = false;
        setError(error instanceof Error ? error.message : "Passkey 创建失败。");
      }
    }));
    return;
  }
  if (message.type === "pairing.awaiting-confirmation") {
    const code = document.createElement("div");
    code.className = "code";
    code.textContent = message.code;
    actionsElement.replaceChildren(code);
    setStatus("仅当桌面显示相同数字时，才在桌面确认绑定。");
    return;
  }
  if (message.type === "pairing.completed") {
    const binding = {
      channelId: pairingDraft.channelId,
      deviceId: pairingDraft.deviceId,
      deviceName: pairingDraft.deviceName,
      signingPrivateKey: pairingDraft.signing.privateKey,
      signingPublicKey: pairingDraft.signing.publicKey,
      agreementPrivateKey: pairingDraft.agreement.privateKey,
      agreementPublicKey: pairingDraft.agreement.publicKey,
      desktopSigningPublicKey: pairingDraft.desktopSigningPublicKey,
      desktopAgreementPublicKey: pairingDraft.desktopAgreementPublicKey,
      passkeyId: pairingDraft.passkeyId
    };
    await saveBinding(binding);
    history.replaceState(null, "", relayHomePath);
    pairing = null;
    pairingDraft = null;
    activeBinding = binding;
    stopped = true;
    socket?.close(1000, "Pairing complete");
    setStatus("绑定完成，正在安全登录…");
    window.setTimeout(connect, 100);
    return;
  }
  if (message.type === "passkey.authentication.options") {
    setStatus("验证身份后即可连接桌面端");
    setActions(button("使用 Passkey 登录", async (event) => {
      const actionButton = event.currentTarget;
      actionButton.disabled = true;
      try {
        const credential = await navigator.credentials.get({ publicKey: credentialRequestOptions(message.options) });
        if (!credential) throw new Error("Passkey 登录已取消。");
        await sendSecure({ type: "passkey.authentication.response", response: serializeAuthentication(credential) });
        setStatus("正在加载手机页面…");
      } catch (error) {
        actionButton.disabled = false;
        setError(error instanceof Error ? error.message : "Passkey 登录失败。");
      }
    }));
    return;
  }
  if (message.type === "session.ready") { setStatus("身份验证成功，正在加载手机页面…"); setActions(); return; }
  if (message.type === "ui.document") {
    if (!activeBinding || typeof message.version !== "string" || typeof message.hash !== "string" || typeof message.signature !== "string" || typeof message.html !== "string") throw new Error("手机页面清单无效。");
    if (await sha256(message.html) !== message.hash) throw new Error("手机页面内容校验失败。");
    const publicKey = await importPublicKey("ECDSA", activeBinding.desktopSigningPublicKey, ["verify"]);
    if (!await verifyProof(publicKey, uiDocumentProof(message.version, message.hash), message.signature)) throw new Error("手机页面签名无效。");
    const cached = activeBinding.cachedUi;
    const html = cached?.hash === message.hash && await sha256(cached.html) === message.hash ? cached.html : message.html;
    activeBinding = { ...activeBinding, cachedUi: { version: message.version, hash: message.hash, signature: message.signature, html: message.html } };
    await saveBinding(activeBinding);
    mountMobileDocument(html);
    return;
  }
  if (message.type === "desktop.event") {
    if (uiReady && iframe?.contentWindow) iframe.contentWindow.postMessage({ source: "codex-pane-bootstrap", type: "event", event: message.event }, "*");
    else queuedUiEvents.push(message.event);
    return;
  }
  if (message.type === "error") {
    const errorMessage = message.message || "桌面端拒绝了本次操作。";
    if (uiReady && iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ source: "codex-pane-bootstrap", type: "disconnected", message: errorMessage }, "*");
    } else {
      setError(errorMessage);
      setActions(button("重新连接", () => location.reload()));
    }
  }
};

const mountMobileDocument = (html) => {
  clearUiLoadTimer();
  const mountedFrame = document.createElement("iframe");
  iframe = mountedFrame;
  uiReady = false;
  mountedFrame.id = "mobile-frame";
  mountedFrame.title = "Codex Pane 手机端";
  mountedFrame.sandbox = "allow-scripts allow-forms allow-popups";
  mountedFrame.srcdoc = html;
  document.body.replaceChildren(mountedFrame);
  uiLoadTimer = window.setTimeout(() => {
    if (iframe !== mountedFrame || uiReady) return;
    iframe = null;
    mountedFrame.remove();
    document.body.replaceChildren(bootstrapRoot);
    setStatus("手机页面加载失败");
    setError("Safari 未能加载手机页面，请刷新后重试。");
    setActions(button("重新加载", () => location.reload()));
  }, 10_000);
};

window.addEventListener("message", (event) => {
  if (!iframe || event.source !== iframe.contentWindow || !event.data || event.data.source !== "codex-pane-mobile-ui") return;
  if (event.data.type === "ready") {
    uiReady = true;
    clearUiLoadTimer();
    for (const queued of queuedUiEvents.splice(0)) iframe.contentWindow.postMessage({ source: "codex-pane-bootstrap", type: "event", event: queued }, "*");
    void sendSecure({ type: "ui.ready" }).catch((error) => setError(error.message));
    return;
  }
  if (event.data.type === "command") void sendSecure({ type: "mobile.command", command: event.data.command }).catch((error) => setError(error.message));
});

const showBindings = (bindings) => {
  setStatus("选择要连接的桌面端");
  const list = document.createElement("div");
  list.className = "device-list";
  for (const binding of bindings) {
    const fingerprint = typeof binding.channelId === "string" ? binding.channelId.slice(0, 6).toUpperCase() : "未知";
    list.append(button(`Codex Pane · ${fingerprint}`, () => { activeBinding = binding; setActions(); connect(); }));
  }
  actionsElement.replaceChildren(list);
};

const start = async () => {
  if (!window.isSecureContext || !crypto.subtle) throw new Error("当前浏览器未提供安全连接环境。请使用 HTTPS；USB 本机验收请用最新版 Chrome 打开 localhost 地址。");
  if (!window.PublicKeyCredential) throw new Error("当前浏览器不支持 Passkey。请使用最新版 Chrome，并确认手机已设置锁屏和可用的凭据提供程序。");
  pairing = parsePairing();
  if (pairing) {
    setStatus("正在准备绑定这部手机…");
    setActions();
    await beginPairing();
    return;
  }
  const bindings = await listBindings();
  if (!bindings.length) { setStatus("这部手机尚未绑定。请在桌面端生成二维码后扫码。"); setActions(); return; }
  if (bindings.length > 1) showBindings(bindings);
  else { activeBinding = bindings[0]; connect(); }
};

start().catch((error) => { setStatus("无法启动手机端"); setError(error instanceof Error ? error.message : String(error)); });
