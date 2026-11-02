<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import QRCode from "qrcode";
import { NAlert, NButton, NCard, NColorPicker, NDescriptions, NDescriptionsItem, NDivider, NForm, NFormItem, NImage, NInput, NInputNumber, NModal, NPopconfirm, NRadioButton, NRadioGroup, NSelect, NSpace, NSwitch, NTag, NText } from "naive-ui";
import type { RemoteAccessStatus } from "../../electron/shared/contracts";
import { useWorkspaceStore } from "../stores/workspace";
import type { AppearanceSettings, ThemeMode, WorkspaceMode } from "../types";

const props = withDefaults(defineProps<{ show: boolean; commandShellPath?: string }>(), {
  commandShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
});
const emit = defineEmits<{ "update:show": [value: boolean]; "update:commandShellPath": [value: string]; "update:workspaceMode": [value: WorkspaceMode] }>();
const store = useWorkspaceStore();

const updateAppearance = (appearance: Partial<AppearanceSettings>): void => store.updateAppearance(appearance);

const workspaceMode = computed({ get: () => store.state.workspaceMode, set: (value: WorkspaceMode) => emit("update:workspaceMode", value) });
const theme = computed({ get: () => store.state.appearance.theme, set: (value: ThemeMode) => updateAppearance({ theme: value }) });
const fontFamily = computed({ get: () => store.state.appearance.fontFamily, set: (value: string | null) => updateAppearance({ fontFamily: value ?? "" }) });
const fontSize = computed({
  get: () => store.state.appearance.fontSize,
  set: (value: number | null) => updateAppearance({ fontSize: Math.min(20, Math.max(12, value ?? 14)) })
});
const accentColor = computed({ get: () => store.state.appearance.accentColor, set: (value: string) => updateAppearance({ accentColor: value }) });
const commandShellPath = computed({ get: () => props.commandShellPath, set: (value: string) => emit("update:commandShellPath", value) });
const unwrapPowerShellCommands = computed({ get: () => store.state.appearance.unwrapPowerShellCommands, set: (value: boolean) => updateAppearance({ unwrapPowerShellCommands: value }) });
const mcpGatewayAdaptation = computed({ get: () => store.state.appearance.mcpGatewayAdaptation, set: (value: boolean) => updateAppearance({ mcpGatewayAdaptation: value }) });
const systemFonts = ref<string[]>([]);
const fontListState = ref<"idle" | "loading" | "ready" | "unavailable" | "denied">("idle");
const diagnosticsState = ref<"idle" | "copying" | "copied" | "empty" | "error">("idle");
const diagnosticsError = ref("");
const runtimeAction = ref<"idle" | "choosing" | "clearing">("idle");
const runtimeError = ref("");
const remoteStatus = ref<RemoteAccessStatus>({ enabled: false, phase: "disabled", message: "远程访问已关闭", relayUrl: "", paired: false, pairing: null, passkeys: [] });
const remoteEnabled = ref(false);
const relayUrl = ref("");
const remoteBusy = ref(false);
const remoteError = ref("");
const pairingQr = ref("");
const pairingClock = ref(Date.now());
const pairingClockTimer = window.setInterval(() => { pairingClock.value = Date.now(); }, 1_000);
const pairingSecondsRemaining = computed(() => Math.max(0, Math.ceil(((remoteStatus.value.pairing?.expiresAt ?? 0) - pairingClock.value) / 1_000)));
const pairingExpired = computed(() => Boolean(remoteStatus.value.pairing) && pairingSecondsRemaining.value === 0);
const pairingTimeLabel = computed(() => {
  const seconds = pairingSecondsRemaining.value;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
const remoteManagedElsewhere = computed(() => remoteStatus.value.phase === "standby");
const remoteSaveLabel = computed(() => remoteEnabled.value ? "保存并连接" : remoteStatus.value.enabled ? "保存并关闭" : "保存设置");
const fontOptions = computed(() => [...new Set([fontFamily.value, ...systemFonts.value].filter(Boolean))].map((family) => ({ label: family, value: family })));
const display = (value: string | null | undefined): string => value || "—";
const noSpellcheckInputProps = { spellcheck: false, autocorrect: "off", autocapitalize: "off" } as const;
const loadSystemFonts = async (): Promise<void> => {
  if (fontListState.value === "loading" || fontListState.value === "ready") return;
  const queryLocalFonts = (window as typeof window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  fontListState.value = "loading";
  try {
    const nativeFonts = queryLocalFonts ? await queryLocalFonts.call(window) : [];
    const browserFamilies = nativeFonts.map((font) => font.family.trim()).filter(Boolean);
    const systemFallback = browserFamilies.length ? [] : await window.codexPane.listSystemFonts?.() ?? [];
    systemFonts.value = [...new Set([...browserFamilies, ...systemFallback].map((family) => family.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
    fontListState.value = systemFonts.value.length ? "ready" : queryLocalFonts ? "unavailable" : "unavailable";
  } catch {
    try {
      systemFonts.value = await window.codexPane.listSystemFonts?.() ?? [];
      fontListState.value = systemFonts.value.length ? "ready" : "denied";
    } catch {
      fontListState.value = queryLocalFonts ? "denied" : "unavailable";
    }
  }
};
const copyDiagnostics = async (): Promise<void> => {
  if (diagnosticsState.value === "copying") return;
  diagnosticsState.value = "copying";
  diagnosticsError.value = "";
  try {
    const lines = await window.codexPane.readDiagnostics();
    if (!lines.length) {
      diagnosticsState.value = "empty";
      return;
    }
    await window.codexPane.copyText(lines.join("\n"));
    diagnosticsState.value = "copied";
  } catch (error) {
    diagnosticsState.value = "error";
    diagnosticsError.value = error instanceof Error ? error.message : String(error);
  }
};
const runRuntimeAction = async (action: "choosing" | "clearing"): Promise<void> => {
  if (runtimeAction.value !== "idle") return;
  runtimeAction.value = action;
  runtimeError.value = "";
  try {
    if (action === "choosing") await store.chooseDefaultDirectory();
    else await store.clearDefaultDirectory();
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    runtimeAction.value = "idle";
  }
};
const syncRemoteStatus = async (status?: RemoteAccessStatus): Promise<void> => {
  const current = status ?? await window.codexPane?.getRemoteAccessStatus?.();
  if (!current) return;
  remoteStatus.value = current;
  remoteEnabled.value = remoteStatus.value.enabled;
  relayUrl.value = remoteStatus.value.relayUrl;
  pairingQr.value = remoteStatus.value.pairing ? await QRCode.toDataURL(remoteStatus.value.pairing.url, { width: 220, margin: 1, errorCorrectionLevel: "M" }) : "";
};
const saveRemoteSettings = async (): Promise<void> => {
  remoteBusy.value = true;
  remoteError.value = "";
  try {
    await syncRemoteStatus(await window.codexPane.updateRemoteSettings({ enabled: remoteEnabled.value, relayUrl: relayUrl.value.trim() }));
  }
  catch (error) { remoteError.value = error instanceof Error ? error.message : String(error); }
  finally { remoteBusy.value = false; }
};
const beginPairing = async (): Promise<void> => {
  remoteBusy.value = true;
  remoteError.value = "";
  try { await syncRemoteStatus(await window.codexPane.beginRemotePairing()); }
  catch (error) { remoteError.value = error instanceof Error ? error.message : String(error); }
  finally { remoteBusy.value = false; }
};
const confirmPairing = async (): Promise<void> => {
  if (!remoteStatus.value.pairing) return;
  remoteBusy.value = true;
  remoteError.value = "";
  try { await window.codexPane.confirmRemotePairing(remoteStatus.value.pairing.pairingId); }
  catch (error) { remoteError.value = error instanceof Error ? error.message : String(error); }
  finally { remoteBusy.value = false; }
};
const removePasskey = async (id: string): Promise<void> => {
  remoteBusy.value = true;
  remoteError.value = "";
  try { await window.codexPane.revokeRemotePasskey(id); }
  catch (error) { remoteError.value = error instanceof Error ? error.message : String(error); }
  finally { remoteBusy.value = false; }
};
const logoutAllMobiles = async (): Promise<void> => {
  remoteBusy.value = true;
  remoteError.value = "";
  try { await window.codexPane.logoutAllRemoteMobiles(); }
  catch (error) { remoteError.value = error instanceof Error ? error.message : String(error); }
  finally { remoteBusy.value = false; }
};
const unsubscribeRemoteStatus = window.codexPane?.onRemoteAccessStatus?.((status) => { void syncRemoteStatus(status); }) ?? (() => undefined);
onBeforeUnmount(() => { window.clearInterval(pairingClockTimer); unsubscribeRemoteStatus(); });
watch(() => props.show, (show) => { if (show) void Promise.all([loadSystemFonts(), syncRemoteStatus()]); }, { immediate: true });
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="设置"
    closable
    class="settings-modal"
    :style="{ width: 'min(780px, calc(100vw - 48px))', height: 'min(720px, calc(100vh - 96px))', maxHeight: 'calc(100vh - 96px)' }"
    content-style="min-height: 0; overflow: auto; padding-right: 18px;"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <NSpace vertical :size="18">
      <section class="settings-section">
        <div class="settings-section-heading"><NText strong>工作台</NText><NText depth="3">选择会话的查看方式。</NText></div>
        <NForm label-placement="left" label-width="148" class="settings-form">
          <NFormItem label="工作台模式">
            <NRadioGroup v-model:value="workspaceMode" name="workspace-mode">
              <NRadioButton value="panes">多窗格</NRadioButton>
              <NRadioButton value="sessionSidebar">会话侧栏</NRadioButton>
            </NRadioGroup>
          </NFormItem>
        </NForm>
      </section>
      <NDivider />
      <section class="settings-section">
        <div class="settings-section-heading"><div class="remote-section-title"><NText strong>远程访问</NText><NText depth="3">在手机上查看和继续会话；敏感设置仍只能在桌面操作。</NText></div><NTag :type="remoteStatus.phase === 'connected' ? 'success' : remoteStatus.phase === 'error' ? 'error' : 'default'">{{ remoteStatus.message }}</NTag></div>
        <NForm label-placement="left" label-width="148" class="settings-form">
          <NFormItem label="启用远程访问"><NSwitch v-model:value="remoteEnabled" :disabled="remoteManagedElsewhere" /></NFormItem>
          <NFormItem label="中转服务地址"><div class="remote-url-field"><NInput v-model:value="relayUrl" :disabled="remoteManagedElsewhere" :input-props="noSpellcheckInputProps" placeholder="https://pane.example.com" /><NText depth="3">填写部署后的 HTTPS 地址，可包含路径前缀；本机调试可使用 localhost。</NText></div></NFormItem>
          <NFormItem label="连接设置"><NSpace><NButton type="primary" secondary :loading="remoteBusy" :disabled="remoteManagedElsewhere" @click="saveRemoteSettings">{{ remoteSaveLabel }}</NButton><NButton v-if="remoteEnabled" secondary :disabled="remoteBusy || remoteManagedElsewhere" @click="beginPairing">{{ remoteStatus.paired ? '添加手机' : '生成配对二维码' }}</NButton></NSpace></NFormItem>
        </NForm>
        <NAlert v-if="remoteManagedElsewhere" type="info">为避免手机连接反复中断，同一时间只有一个应用实例提供远程访问。关闭管理中的实例后，请重启本窗口接管。</NAlert>
        <NAlert v-if="remoteError" type="error" closable @close="remoteError = ''">{{ remoteError }}</NAlert>
        <NCard v-if="remoteStatus.pairing" size="small" class="pairing-card">
          <NSpace align="center" :wrap="false">
            <NImage v-if="pairingQr" :src="pairingQr" width="160" preview-disabled alt="手机配对二维码" />
            <div class="pairing-copy">
              <NText strong>{{ remoteStatus.pairing.readyToConfirm ? '核对确认码' : '用手机 APP 扫描或粘贴配对链接' }}</NText>
              <NText v-if="pairingExpired" type="error">二维码已过期，请重新生成。</NText>
              <NText v-else-if="remoteStatus.pairing.readyToConfirm" depth="3">仅当手机显示相同的数字时确认。</NText>
              <NText v-else depth="3">等待手机完成登记，二维码将在 {{ pairingTimeLabel }} 后过期。</NText>
              <div v-if="remoteStatus.pairing.readyToConfirm" class="pairing-code">{{ remoteStatus.pairing.code }}</div>
              <NButton type="primary" :loading="remoteBusy" :disabled="pairingExpired || !remoteStatus.pairing.readyToConfirm" @click="confirmPairing">{{ remoteStatus.pairing.readyToConfirm ? '确认并完成绑定' : '等待手机登记' }}</NButton>
            </div>
          </NSpace>
        </NCard>
        <NCard v-if="remoteStatus.passkeys.length" size="small" title="已绑定手机" class="passkey-card">
          <div v-for="passkey in remoteStatus.passkeys" :key="passkey.id" class="passkey-row"><div><NText>{{ passkey.name }}</NText><NText depth="3">绑定时间：{{ new Date(passkey.createdAt).toLocaleString() }}</NText><NText depth="3">最近使用：{{ passkey.lastUsedAt ? new Date(passkey.lastUsedAt).toLocaleString() : '尚未使用' }}</NText></div><NPopconfirm :disabled="remoteBusy || remoteManagedElsewhere" @positive-click="removePasskey(passkey.id)"><template #trigger><NButton size="small" tertiary type="error" :loading="remoteBusy" :disabled="remoteBusy || remoteManagedElsewhere">撤销</NButton></template>撤销后，这部手机将立即无法连接。</NPopconfirm></div>
          <template #footer><NPopconfirm :disabled="remoteBusy || remoteManagedElsewhere" @positive-click="logoutAllMobiles"><template #trigger><NButton size="small" secondary :loading="remoteBusy" :disabled="remoteBusy || remoteManagedElsewhere">退出所有手机</NButton></template>浏览器需要重新验证；原生后台连接会自动重连。若要禁止某台设备连接，请撤销该设备。</NPopconfirm></template>
        </NCard>
      </section>
      <NDivider />
      <section class="settings-section">
        <div class="settings-section-heading"><NText strong>外观</NText><NSpace align="center"><NText depth="3">更改会立即应用。</NText><NButton size="tiny" secondary @click="store.resetAppearance">恢复默认</NButton></NSpace></div>
        <NForm label-placement="left" label-width="148" class="settings-form">
          <NFormItem label="主题">
            <NRadioGroup v-model:value="theme" name="appearance-theme"><NRadioButton value="system">跟随系统</NRadioButton><NRadioButton value="dark">深色</NRadioButton><NRadioButton value="light">浅色</NRadioButton></NRadioGroup>
          </NFormItem>
          <NFormItem label="界面字体">
            <div class="font-field">
              <NSelect v-model:value="fontFamily" :options="fontOptions" filterable clearable placeholder="选择系统字体，留空使用默认字体" />
              <NText v-if="fontListState === 'loading'" depth="3">正在读取系统字体…</NText>
              <NText v-else-if="fontListState === 'ready'" depth="3">已读取 {{ systemFonts.length }} 个字体系列。</NText>
              <NText v-else-if="fontListState === 'unavailable'" depth="3">当前环境不支持读取系统字体，已保留当前设置。</NText>
              <NText v-else-if="fontListState === 'denied'" depth="3">未获得系统字体访问权限，已保留当前设置。</NText>
            </div>
          </NFormItem>
          <NFormItem label="字号"><NInputNumber v-model:value="fontSize" :min="12" :max="20" :step="1" /></NFormItem>
          <NFormItem label="强调色"><NColorPicker v-model:value="accentColor" :modes="['hex']" :show-alpha="false" /></NFormItem>
        </NForm>
      </section>
      <NDivider />
      <section class="settings-section">
        <div class="settings-section-heading"><NText strong>Codex 运行环境</NText><NText depth="3">用于新会话和命令执行。</NText></div>
        <NForm label-placement="left" label-width="148" class="settings-form runtime-form">
          <NFormItem label="默认工作目录">
            <NCard size="small" embedded>
              <NSpace align="center" justify="space-between">
                <NText class="directory-value">{{ store.state.defaultCwd || "未设置，将使用应用目录" }}</NText>
                <NSpace :wrap="false">
                  <NButton type="primary" secondary :loading="runtimeAction === 'choosing'" :disabled="runtimeAction !== 'idle'" @click="runRuntimeAction('choosing')">选择目录</NButton>
                  <NButton v-if="store.state.defaultCwd" secondary :loading="runtimeAction === 'clearing'" :disabled="runtimeAction !== 'idle'" @click="runRuntimeAction('clearing')">清空</NButton>
                </NSpace>
              </NSpace>
            </NCard>
          </NFormItem>
          <NAlert v-if="runtimeError" type="error" closable @close="runtimeError = ''">无法更新运行目录：{{ runtimeError }}</NAlert>
          <NFormItem label="pwsh 路径">
            <NInput v-model:value="commandShellPath" :input-props="noSpellcheckInputProps" clearable placeholder="C:\Program Files\PowerShell\7\pwsh.exe" />
          </NFormItem>
          <NFormItem label="简化 pwsh 命令">
            <NSwitch v-model:value="unwrapPowerShellCommands" />
          </NFormItem>
          <NFormItem label="MCP Gateway 适配">
            <div class="switch-with-help"><NSwitch v-model:value="mcpGatewayAdaptation" /><NText depth="3">把 gateway_call_tool / call_tool 的目标服务与真实工具名称直接展示在工具卡片中；只影响显示，不修改协议请求。</NText></div>
          </NFormItem>
        </NForm>
      </section>
      <NDivider />
      <section class="settings-section">
        <div class="settings-section-heading"><NText strong>当前有效配置</NText><NText depth="3">只读</NText></div>
        <NDescriptions v-if="store.state.effectiveConfig" label-placement="left" bordered :column="2">
          <NDescriptionsItem label="默认模型">{{ display(store.state.effectiveConfig.model) }}</NDescriptionsItem>
          <NDescriptionsItem label="模型提供方">{{ display(store.state.effectiveConfig.modelProvider) }}</NDescriptionsItem>
          <NDescriptionsItem label="沙箱模式">{{ display(store.state.effectiveConfig.sandboxMode) }}</NDescriptionsItem>
          <NDescriptionsItem label="操作确认">{{ display(store.state.effectiveConfig.approvalPolicy) }}</NDescriptionsItem>
          <NDescriptionsItem label="确认评审方">{{ display(store.state.effectiveConfig.approvalReviewer) }}</NDescriptionsItem>
          <NDescriptionsItem label="推理强度">{{ display(store.state.effectiveConfig.reasoningEffort) }}</NDescriptionsItem>
          <NDescriptionsItem label="联网搜索">{{ display(store.state.effectiveConfig.webSearch) }}</NDescriptionsItem>
          <NDescriptionsItem label="服务层级">{{ display(store.state.effectiveConfig.serviceTier) }}</NDescriptionsItem>
        </NDescriptions>
        <NText v-else depth="3">Codex 尚未返回有效配置。</NText>
        <NSpace v-if="store.state.permissionProfiles.length" class="permission-profiles" align="center">
          <NText depth="3">权限配置</NText>
          <NTag v-for="profile in store.state.permissionProfiles" :key="profile.id" size="small" :type="profile.allowed ? 'success' : 'default'">{{ profile.id }} · {{ profile.allowed ? "可用" : "不可用" }}</NTag>
        </NSpace>
      </section>
      <NDivider />
      <section class="settings-section">
        <div class="settings-section-heading"><NText strong>诊断与兼容性</NText><NText depth="3">最近 200 条</NText></div>
        <NDescriptions label-placement="left" bordered :column="2" class="diagnostics-summary">
          <NDescriptionsItem label="PaneFlow Desktop">{{ store.state.appVersion }}</NDescriptionsItem>
          <NDescriptionsItem label="连接状态">{{ store.state.connection.message }}</NDescriptionsItem>
          <NDescriptionsItem label="Codex 版本">{{ display(store.state.connection.codexVersion) }}</NDescriptionsItem>
        </NDescriptions>
        <NSpace align="center" class="diagnostics-actions">
          <NButton secondary :loading="diagnosticsState === 'copying'" @click="copyDiagnostics">复制脱敏诊断</NButton>
          <NText depth="3">用于报告连接和协议问题；凭据、令牌与用户目录会在写入日志前隐藏。</NText>
        </NSpace>
        <NAlert v-if="diagnosticsState === 'copied'" type="success">诊断信息已复制到剪贴板。</NAlert>
        <NAlert v-else-if="diagnosticsState === 'empty'" type="info">当前还没有诊断记录。</NAlert>
        <NAlert v-else-if="diagnosticsState === 'error'" type="error">无法复制诊断信息：{{ diagnosticsError }}</NAlert>
      </section>
    </NSpace>
    <template #footer><NSpace justify="end"><NButton type="primary" @click="emit('update:show', false)">完成</NButton></NSpace></template>
  </NModal>
</template>

<style scoped>
.settings-section { min-width: 0; }
.settings-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.settings-section-heading > :first-child { font-weight: 700; }
.remote-section-title, .remote-url-field { display: grid; gap: 4px; min-width: 0; }
.settings-form { margin-top: 12px; }
.settings-form :deep(.n-form-item-label), :deep(.n-descriptions-table-header) { font-weight: 600; }
.directory-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.font-field { display: grid; width: 100%; gap: 5px; }
.switch-with-help { display: grid; gap: 5px; }
.font-field .n-text { font-size: 12px; }
.runtime-form :deep(.n-card) { width: 100%; }
.settings-form :deep(.n-input-number) { width: 100%; }
.permission-profiles { margin-top: 12px; }
.diagnostics-summary, .diagnostics-actions { margin-top: 12px; }
.pairing-card, .passkey-card { margin-top: 12px; }
.pairing-copy { display: grid; gap: 8px; }
.pairing-code { font: 700 28px/1.2 ui-monospace, monospace; letter-spacing: 5px; }
.passkey-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; }
.passkey-row > div { display: grid; gap: 3px; }
@media (max-width: 620px) {
  .settings-form :deep(.n-form-item) { grid-template-columns: 1fr !important; }
  .settings-form :deep(.n-form-item-label) { padding-bottom: 5px; text-align: left; }
  .pairing-card :deep(.n-space) { align-items: center !important; flex-direction: column !important; }
  .pairing-copy { width: 100%; text-align: center; }
  .passkey-row { align-items: flex-start; }
}
</style>
