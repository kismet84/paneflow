<script setup lang="ts">
import { ref } from "vue";
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NSpace, NText } from "naive-ui";
import type { DeploymentConfig, DeploymentStatus } from "../../electron/shared/deployment-contracts";
import type { UpdateStatus } from "../../electron/shared/update-contracts";
const api = window.codexPane;
const expanded = ref(false), busy = ref(false), error = ref("");
const status = ref<DeploymentStatus | null>(null), update = ref<UpdateStatus | null>(null);
const checks = ref<Array<{ key: string; label: string; ok: boolean; detail: string }>>([]);
const config = ref<DeploymentConfig>({ origin: "", nodePath: "", cloudflaredPath: "", tunnelConfigPath: "", tunnelId: "", cwd: "", port: 48322, enabled: false });
async function run(action: () => Promise<unknown>) { if (busy.value) return; busy.value = true; error.value = ""; try { await action(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { busy.value = false; } }
async function open() { expanded.value = !expanded.value; if (expanded.value) await run(async () => { const saved = await api.deploymentGet(); status.value = saved.status; config.value = saved.config ?? { ...config.value, ...saved.defaults }; }); }
const fields: Array<{ key: "origin" | "nodePath" | "cloudflaredPath" | "tunnelConfigPath" | "tunnelId" | "cwd"; label: string; placeholder: string }> = [
  { key: "origin", label: "固定 HTTPS 入口", placeholder: "https://your-domain.example" },
  { key: "nodePath", label: "Node 路径", placeholder: "Node 可执行文件完整路径" },
  { key: "cloudflaredPath", label: "cloudflared 路径", placeholder: "C:\\Tools\\cloudflared.exe" },
  { key: "tunnelConfigPath", label: "已有隧道配置文件", placeholder: "C:\\Users\\you\\.cloudflared\\config.yml" },
  { key: "tunnelId", label: "已有固定隧道 ID", placeholder: "隧道 UUID" },
  { key: "cwd", label: "默认工作目录", placeholder: "D:\\projects" }
];
</script>
<template>
  <section class="deployment-panel">
    <NSpace justify="space-between" align="center"><NText strong>安装、部署与升级</NText><NButton @click="open">{{ expanded ? "收起" : "打开配置向导" }}</NButton></NSpace>
    <NSpace v-if="expanded" vertical :size="14" style="margin-top:16px">
      <NAlert type="info" :show-icon="false">使用已有固定域名和隧道。本向导不会创建云端资源或覆盖隧道配置。已有外部守护运行时，请继续使用原部署，避免重复启动。</NAlert>
      <NForm label-placement="top">
        <NFormItem v-for="field in fields" :key="field.key" :label="field.label"><NInput v-model:value="config[field.key]" :placeholder="field.placeholder" :disabled="busy" /></NFormItem>
        <NFormItem label="本机中继端口"><NInputNumber v-model:value="config.port" :min="1024" :max="65535" :disabled="busy" /></NFormItem>
        <NCheckbox v-model:checked="config.enabled" :disabled="busy">下次打开应用时启动此配置的公网服务</NCheckbox>
      </NForm>
      <NSpace><NButton :disabled="busy" @click="run(async()=>{checks=(await api.deploymentCheck({ ...config })).checks})">检测配置与连接</NButton><NButton :disabled="busy" @click="run(async()=>{await api.deploymentSave({ ...config });status=(await api.deploymentGet()).status})">保存配置</NButton><NButton :disabled="busy" @click="run(async()=>{status=await api.deploymentStart()})">启动公网服务</NButton><NButton :disabled="busy" @click="run(async()=>{status=await api.deploymentStop()})">停止本应用启动的服务</NButton></NSpace>
      <NAlert v-for="check in checks" :key="check.key" :type="check.ok?'success':'warning'" :title="check.label">{{ check.detail }}</NAlert>
      <NText v-if="status">{{ status.message }}</NText>
      <NButton :disabled="busy" @click="run(async()=>{status=await api.deploymentAutostart(!status?.autostart)})">{{ status?.autostart?'关闭登录自启':'连接测试通过后开启登录自启' }}</NButton>
      <NText strong>应用更新</NText>
      <NText depth="3">仅从本项目 GitHub 发布读取更新；下载、安装分别确认。任务结束后升级，保留本机配置备份。</NText>
      <NSpace><NButton :disabled="busy" @click="run(async()=>{update=await api.updateCheck()})">检查新版本</NButton><NButton v-if="update?.available&&!update.prepared" :disabled="busy" @click="run(async()=>{update=await api.updatePrepare()})">下载并校验</NButton><NButton v-if="update?.prepared" :disabled="busy" type="primary" @click="run(()=>api.updateInstall())">备份并安装更新…</NButton></NSpace>
      <NText v-if="update">{{ update.message }}</NText><NAlert v-if="update?.manifest" :title="`版本 ${update.manifest.version} · 协议 ${update.manifest.minProtocol}–${update.manifest.maxProtocol}`" :show-icon="false"><pre style="white-space:pre-wrap;font:inherit">{{ update.manifest.notes }}</pre></NAlert>
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NSpace>
  </section>
</template>
