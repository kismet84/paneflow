<script setup>
import { ref } from 'vue';
import { registerPlugin } from '@capacitor/core';
import { parseConnection } from './connection';

const savedKey = 'pane-companion-relay-home';
const ChromeSession = registerPlugin('ChromeSession');
const address = ref('');
const saved = ref('');
const error = ref('');
const opening = ref(false);
try {
  const value = localStorage.getItem(savedKey);
  if (value) saved.value = parseConnection(value).homeUrl;
} catch { localStorage.removeItem(savedKey); }

async function open(value) {
  if (opening.value) return;
  error.value = '';
  try {
    const connection = parseConnection(value);
    opening.value = true;
    // shortcut: use Custom Tabs for browser Passkey support until embedded authentication is validated.
    await ChromeSession.open({ url: connection.openUrl });
    localStorage.setItem(savedKey, connection.homeUrl);
    saved.value = connection.homeUrl;
    address.value = ''; // Pairing fragments never enter persistent storage.
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法打开连接，请检查浏览器。'; }
  finally { opening.value = false; }
}
function forget() { localStorage.removeItem(savedKey); saved.value = ''; }
</script>

<template>
  <main>
    <header><div class="logo" aria-hidden="true">P</div><div><p class="eyebrow">WINDOWS × ANDROID</p><h1>Pane Companion</h1></div><span class="tag">原型</span></header>
    <section class="intro"><p class="eyebrow">你的电脑，随时接续</p><h2>把会话带到手机</h2><p>连接 Windows 上的 Codex Pane，查看任务、继续对话，并处理支持的操作确认。</p></section>
    <section class="card">
      <h3>连接电脑</h3><label for="address">粘贴桌面配对链接</label>
      <textarea id="address" v-model="address" rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="https://…/#pair=…" />
      <p class="hint">也可输入已绑定的中继地址。首次使用请在电脑端生成配对链接。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" :disabled="opening || !address.trim()" @click="open(address)">{{ opening ? '正在打开…' : '打开安全会话' }} <span aria-hidden="true">↗</span></button>
    </section>
    <section v-if="saved" class="card saved"><div><h3>上次连接</h3><p>{{ saved }}</p></div><button class="primary" :disabled="opening" @click="open(saved)">继续连接</button><button class="text" @click="forget">移除此地址</button></section>
    <section class="steps"><h3>首次配对</h3><ol><li>电脑开启远程访问，复制配对链接。</li><li>手机打开链接，按提示创建 Passkey。</li><li>核对两端确认码，在电脑完成绑定。</li></ol></section>
    <footer><strong>当前原型使用 Chrome 安全浏览窗口</strong><p>请先安装并启用 Google Chrome。聊天、配对与重连在 Chrome 中完成，不改变默认浏览器；返回键可回到本页。电脑需保持运行。这里只保存中继地址，不保存配对密钥。</p><details><summary>USB 本机验证</summary><p>Windows 使用 <code>http://localhost:48321</code> 作为中继地址，并执行 <code>adb reverse tcp:48321 tcp:48321</code>。仅连接已授权的电脑。</p></details></footer>
  </main>
</template>
