<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCheckbox, NCode, NDescriptions, NDescriptionsItem, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, NSpin, NSwitch, NTag, NText } from "naive-ui";
import type { PendingServerRequest } from "../types";
import { buildApprovalDecision } from "../protocol/server-request-policy";

const props = defineProps<{ requests: PendingServerRequest[]; show: boolean; paneId: string | null; resolving: boolean }>();
const emit = defineEmits<{
  "update:show": [value: boolean];
  resolve: [request: PendingServerRequest, result?: unknown, error?: { code: number; message: string }];
}>();

const answers = reactive<Record<string, string>>({});
const otherAnswers = reactive<Record<string, string>>({});
const formJson = ref("{}");
const formError = ref("");
const elicitationValues = reactive<Record<string, unknown>>({});
const permissionSelection = reactive({ network: true, fileSystem: true });
const root = ref<HTMLElement | null>(null);
const noSpellcheckInputProps = { spellcheck: false, autocorrect: "off", autocapitalize: "off" } as const;
const visibleRequests = computed(() => props.paneId ? props.requests.filter((request) => request.paneId === props.paneId) : props.requests);
const activeRequest = computed(() => visibleRequests.value[0] ?? null);
const params = computed(() => activeRequest.value?.params ?? {});

const displayMethod = computed(() => ({
  "item/commandExecution/requestApproval": "命令需要确认",
  "item/fileChange/requestApproval": "文件修改需要确认",
  "item/permissions/requestApproval": "权限请求",
  "item/tool/requestUserInput": "Codex 需要你的回答",
  "mcpServer/elicitation/request": "MCP 服务需要补充信息",
  "item/tool/call": "客户端工具调用",
  "account/chatgptAuthTokens/refresh": "账号令牌刷新",
  "attestation/generate": "设备证明请求",
  "applyPatchApproval": "文件修改需要确认",
  "execCommandApproval": "命令需要确认"
}[activeRequest.value?.method ?? ""] ?? "Codex 请求确认"));

const questions = computed(() => Array.isArray(params.value.questions) ? params.value.questions.map((question) => question as Record<string, unknown>) : []);
const requestedSchema = computed(() => params.value.requestedSchema && typeof params.value.requestedSchema === "object" ? params.value.requestedSchema as Record<string, unknown> : {});
const elicitationFields = computed(() => {
  const properties = requestedSchema.value.properties && typeof requestedSchema.value.properties === "object" ? requestedSchema.value.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(requestedSchema.value.required) ? requestedSchema.value.required.map(String) : []);
  return Object.entries(properties).map(([name, rawSchema]) => ({ name, schema: rawSchema && typeof rawSchema === "object" ? rawSchema as Record<string, unknown> : {}, required: required.has(name) }));
});
const availableDecisions = computed(() => Array.isArray(params.value.availableDecisions)
  ? params.value.availableDecisions
  : ["accept", "acceptForSession", "decline", "cancel"]);
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const permissionProfile = computed(() => asRecord(params.value.permissions ?? params.value.additionalPermissions));
const networkPermission = computed(() => asRecord(permissionProfile.value.network));
const fileSystemPermission = computed(() => asRecord(permissionProfile.value.fileSystem));
const filePermissionEntries = computed<Array<{ access: string; path: unknown }>>(() => {
  const entries = Array.isArray(fileSystemPermission.value.entries) ? fileSystemPermission.value.entries : [];
  const legacy = [
    ...(Array.isArray(fileSystemPermission.value.read) ? fileSystemPermission.value.read.map((path) => ({ access: "读取", path })) : []),
    ...(Array.isArray(fileSystemPermission.value.write) ? fileSystemPermission.value.write.map((path) => ({ access: "写入", path })) : [])
  ];
  return [...entries.map((entry) => {
    const detail = asRecord(entry);
    return { access: String(detail.access ?? "文件访问"), path: detail.path };
  }), ...legacy];
});
const requestedFileChanges = computed(() => {
  if (Array.isArray(params.value.fileChanges)) return params.value.fileChanges.map((change, index) => ({ path: String(asRecord(change).path ?? `文件 ${index + 1}`), change: asRecord(change) }));
  return Object.entries(asRecord(params.value.fileChanges)).map(([path, change]) => ({ path, change: asRecord(change) }));
});
const requestedCommandActions = computed(() => Array.isArray(params.value.commandActions) ? params.value.commandActions.map(asRecord) : []);
const fileChangeLabel = (change: Record<string, unknown>): string => ({ add: "新增", delete: "删除", update: "修改" }[String(change.type)] ?? "变更");
const redactForDisplay = (value: unknown, key = "", depth = 0): unknown => {
  if (/(token|authorization|api.?key|password|secret)/i.test(key)) return "[已隐藏]";
  if (depth > 7 && value && typeof value === "object") return "…已省略";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactForDisplay(entry, "", depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([entryKey, entry]) => [entryKey, redactForDisplay(entry, entryKey, depth + 1)]));
  if (typeof value === "string") return value
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        for (const queryKey of [...url.searchParams.keys()]) url.searchParams.set(queryKey, "[已隐藏]");
        return url.toString();
      } catch {
        return rawUrl;
      }
    })
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT 已隐藏]");
  return value;
};
const commandActionLabel = (action: Record<string, unknown>): string => {
  const kind = ({ read: "读取文件", listFiles: "列出文件", search: "搜索内容", unknown: "执行命令" } as Record<string, string>)[String(action.type)] ?? "执行命令";
  return `${kind}：${String(redactForDisplay(action.path ?? action.query ?? action.name ?? action.command ?? "未提供详情"))}`;
};
const safeJson = (value: unknown): string => JSON.stringify(redactForDisplay(value), null, 2);
const displayPath = (value: unknown): string => typeof value === "string" ? value : safeJson(value);
const shellArgument = (value: unknown): string => {
  const argument = String(redactForDisplay(value));
  return /[\s"'`$;]/u.test(argument) ? `'${argument.replaceAll("'", "''")}'` : argument;
};
const commandDisplay = computed(() => Array.isArray(params.value.command)
  ? params.value.command.map(shellArgument).join(" ")
  : String(redactForDisplay(params.value.command ?? "")));

const decisionLabel = (decision: unknown): string => {
  if (decision === "accept") return "允许一次";
  if (decision === "acceptForSession") return "本次会话允许";
  if (decision === "decline") return "拒绝";
  if (decision === "cancel") return "拒绝并中断";
  if (typeof decision === "object") {
    const detail = asRecord(decision);
    if (detail.acceptWithExecpolicyAmendment) return "允许并记住命令规则";
    if (detail.applyNetworkPolicyAmendment) return "允许并应用网络规则";
    return "按建议策略允许";
  }
  return String(decision);
};

const decisionType = (decision: unknown): "primary" | "warning" | "error" | "default" => {
  if (decision === "accept") return "primary";
  if (decision === "acceptForSession") return "warning";
  if (decision === "decline" || decision === "cancel") return "error";
  return "default";
};

const resolveDecision = (decision: unknown): void => {
  if (!activeRequest.value) return;
  emit("resolve", activeRequest.value, buildApprovalDecision(activeRequest.value.method, decision));
};

const submitAnswers = (): void => {
  if (!activeRequest.value) return;
  const unanswered = questions.value.find((question) => {
    const id = String(question.id ?? "");
    return !answers[id] || answers[id] === "__other__" && !otherAnswers[id]?.trim();
  });
  if (unanswered) {
    formError.value = `请回答${String(unanswered.header ?? unanswered.question ?? "当前问题")}。`;
    return;
  }
  const result = Object.fromEntries(questions.value.map((question) => {
    const id = String(question.id ?? "");
    return [id, { answers: [answers[id] === "__other__" ? otherAnswers[id]!.trim() : answers[id]!] }];
  }));
  formError.value = "";
  emit("resolve", activeRequest.value, { answers: result });
};
const chooseAnswer = (question: Record<string, unknown>, value: string): void => {
  const id = String(question.id ?? "");
  answers[id] = value;
  formError.value = "";
  const ready = value !== "__other__" && questions.value.every((candidate) => {
    const candidateId = String(candidate.id ?? "");
    return Array.isArray(candidate.options) && Boolean(answers[candidateId]) && answers[candidateId] !== "__other__";
  });
  if (ready) submitAnswers();
};
const showAnswerSubmit = computed(() => questions.value.some((question) => {
  const id = String(question.id ?? "");
  return !Array.isArray(question.options) || answers[id] === "__other__";
}));

const acceptPermissions = (scope: "turn" | "session"): void => {
  if (!activeRequest.value) return;
  const requested = params.value.permissions && typeof params.value.permissions === "object" ? params.value.permissions as Record<string, unknown> : {};
  const permissions = Object.fromEntries(Object.entries(requested).filter(([key, value]) => value !== null && permissionSelection[key as "network" | "fileSystem"] !== false));
  emit("resolve", activeRequest.value, { permissions, scope });
};

const submitElicitation = (action: "accept" | "decline" | "cancel"): void => {
  if (!activeRequest.value) return;
  if (action !== "accept") {
    emit("resolve", activeRequest.value, { action, content: null, _meta: null });
    return;
  }
  try {
    let content: unknown;
    if (params.value.mode === "url") {
      content = null;
    } else if (params.value.mode === "form") {
      const missing = elicitationFields.value.find((field) => {
        const value = elicitationValues[field.name];
        return field.required && (value === undefined || value === "" || Array.isArray(value) && value.length === 0);
      });
      if (missing) {
        formError.value = `请填写${String(missing.schema.title ?? missing.name)}。`;
        return;
      }
      const invalid = elicitationFields.value.map((field) => {
        const value = elicitationValues[field.name];
        const label = String(field.schema.title ?? field.name);
        if (typeof value === "string") {
          if (typeof field.schema.minLength === "number" && value.length < field.schema.minLength) return `${label}至少需要 ${field.schema.minLength} 个字符。`;
          if (typeof field.schema.maxLength === "number" && value.length > field.schema.maxLength) return `${label}不能超过 ${field.schema.maxLength} 个字符。`;
          if (typeof field.schema.pattern === "string") {
            try { if (!new RegExp(field.schema.pattern).test(value)) return `${label}格式不符合要求。`; } catch { return `${label}的格式规则无效，请拒绝此请求并检查 MCP 服务。`; }
          }
        }
        if (typeof value === "number") {
          if (field.schema.type === "integer" && !Number.isInteger(value)) return `${label}必须是整数。`;
          if (typeof field.schema.minimum === "number" && value < field.schema.minimum) return `${label}不能小于 ${field.schema.minimum}。`;
          if (typeof field.schema.maximum === "number" && value > field.schema.maximum) return `${label}不能大于 ${field.schema.maximum}。`;
        }
        if (Array.isArray(value)) {
          if (typeof field.schema.minItems === "number" && value.length < field.schema.minItems) return `${label}至少选择 ${field.schema.minItems} 项。`;
          if (typeof field.schema.maxItems === "number" && value.length > field.schema.maxItems) return `${label}最多选择 ${field.schema.maxItems} 项。`;
        }
        return "";
      }).find(Boolean);
      if (invalid) {
        formError.value = invalid;
        return;
      }
      content = Object.fromEntries(elicitationFields.value
        .filter((field) => elicitationValues[field.name] !== undefined && elicitationValues[field.name] !== "")
        .map((field) => [field.name, elicitationValues[field.name]]));
    } else {
      content = JSON.parse(formJson.value);
    }
    formError.value = "";
    emit("resolve", activeRequest.value, { action, content, _meta: params.value._meta ?? null });
  } catch {
    formError.value = "表单 JSON 格式无效，请修正后再提交。";
  }
};

const fieldOptions = (schema: Record<string, unknown>): Array<{ label: string; value: string }> => {
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => {
    const option = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { label: String(option.title ?? option.const ?? ""), value: String(option.const ?? "") };
  });
  if (Array.isArray(schema.enum)) return schema.enum.map((value, index) => ({ label: String(Array.isArray(schema.enumNames) ? schema.enumNames[index] ?? value : value), value: String(value) }));
  const items = schema.items && typeof schema.items === "object" ? schema.items as Record<string, unknown> : {};
  if (Array.isArray(items.anyOf)) return items.anyOf.map((entry) => {
    const option = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { label: String(option.title ?? option.const ?? ""), value: String(option.const ?? "") };
  });
  return Array.isArray(items.enum) ? items.enum.map((value) => ({ label: String(value), value: String(value) })) : [];
};
const fieldBooleanValue = (name: string): boolean => elicitationValues[name] === true;
const fieldNumberValue = (name: string): number | null => typeof elicitationValues[name] === "number" ? elicitationValues[name] : null;
const fieldSelectValue = (name: string): string | string[] | null => {
  const value = elicitationValues[name];
  return typeof value === "string" || Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
};
const fieldStringValue = (name: string): string => typeof elicitationValues[name] === "string" ? elicitationValues[name] : "";
const updateField = (name: string, value: unknown): void => { elicitationValues[name] = value; };
const selectionOnlyElicitation = computed(() => params.value.mode === "form" && elicitationFields.value.length === 1
  && elicitationFields.value[0]!.schema.type !== "array" && fieldOptions(elicitationFields.value[0]!.schema).length > 0);
const chooseElicitationOption = (field: { name: string; schema: Record<string, unknown> }, value: string): void => {
  updateField(field.name, value);
  formError.value = "";
  if (selectionOnlyElicitation.value) submitElicitation("accept");
};

const handleKeydown = (event: KeyboardEvent): void => {
  if (!root.value || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], .n-input, .n-base-selection")) return;
  const buttons = [...root.value.querySelectorAll<HTMLElement>("button:not(:disabled), [role='radio']:not([aria-disabled='true'])")];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLElement);
  const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  buttons[(current + direction + buttons.length) % buttons.length]?.focus();
};

const focusFirstAction = async (): Promise<void> => {
  await nextTick();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const action = root.value?.querySelector<HTMLElement>("button:not(:disabled), [role='radio']:not([aria-disabled='true'])");
    if (action) {
      action.focus();
      return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

watch(() => activeRequest.value ? `${activeRequest.value.generation}:${typeof activeRequest.value.id}:${String(activeRequest.value.id)}` : "", () => {
  for (const key of Object.keys(answers)) delete answers[key];
  for (const key of Object.keys(otherAnswers)) delete otherAnswers[key];
  for (const key of Object.keys(elicitationValues)) delete elicitationValues[key];
  formError.value = "";
  formJson.value = "{}";
  permissionSelection.network = true;
  permissionSelection.fileSystem = true;
  for (const field of elicitationFields.value) {
    if (field.schema.default !== undefined) elicitationValues[field.name] = field.schema.default;
    else if (field.schema.type === "boolean") elicitationValues[field.name] = false;
    else if (field.schema.type === "array") elicitationValues[field.name] = [];
  }
  void focusFirstAction();
}, { immediate: true });

const rejectUnsupported = (): void => {
  if (activeRequest.value) {
    emit("resolve", activeRequest.value, undefined, { code: -32000, message: "PaneFlow Desktop 未注册此客户端能力，已安全拒绝请求。" });
  }
};

const elicitationHost = computed(() => {
  try {
    return typeof params.value.url === "string" ? new URL(params.value.url).host : "外部网站";
  } catch {
    return "无效链接";
  }
});

const openElicitationUrl = async (): Promise<void> => {
  if (typeof params.value.url === "string") {
    try {
      await window.codexPane.openExternal(params.value.url);
    } catch (error) {
      formError.value = `无法打开链接：${error instanceof Error ? error.message : String(error)}`;
    }
  }
};
</script>

<template>
  <section v-if="show && activeRequest" ref="root" class="inline-approval" :aria-label="displayMethod" @keydown="handleKeydown">
    <header class="inline-approval-header">
      <strong>{{ displayMethod }}</strong>
      <div class="inline-approval-meta"><NTag v-if="params.review || params.strictAutoReview" size="small" type="warning">自动审查后需要确认</NTag><NText depth="3">{{ visibleRequests.length }} 项待处理</NText></div>
    </header>
        <NSpin :show="resolving" description="正在提交决定…">
        <NSpace vertical :size="10">
          <NDescriptions bordered :column="1" size="small" label-placement="left">
            <NDescriptionsItem v-if="params.reason" label="原因">{{ params.reason }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.command" label="命令"><NCode :code="commandDisplay" language="powershell" word-wrap /></NDescriptionsItem>
            <NDescriptionsItem v-if="params.cwd" label="工作目录">{{ params.cwd }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.serverName" label="MCP 服务">{{ params.serverName }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.tool" label="工具">{{ params.tool }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.message" label="说明">{{ params.message }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.grantRoot" label="会话写入范围">{{ params.grantRoot }}</NDescriptionsItem>
            <NDescriptionsItem v-if="params.networkApprovalContext" label="网络目标">{{ (params.networkApprovalContext as Record<string, unknown>).protocol }}://{{ (params.networkApprovalContext as Record<string, unknown>).host }}</NDescriptionsItem>
          </NDescriptions>

          <template v-if="activeRequest.method === 'item/tool/requestUserInput'">
            <NForm label-placement="top">
              <NFormItem v-for="question in questions" :key="String(question.id)" class="approval-question" :label="String(question.question ?? question.header ?? '请输入')">
                <template v-if="Array.isArray(question.options)">
                  <NSpace vertical>
                      <NButton v-for="option in question.options" :key="String((option as Record<string, unknown>).label)" class="approval-option-button" :type="answers[String(question.id)] === String((option as Record<string, unknown>).label) ? 'primary' : 'default'" @click="chooseAnswer(question, String((option as Record<string, unknown>).label))">
                        <span class="approval-option-label">{{ (option as Record<string, unknown>).label }}</span>
                        <span v-if="(option as Record<string, unknown>).description" class="approval-option-description">{{ (option as Record<string, unknown>).description }}</span>
                      </NButton>
                      <NButton v-if="question.isOther" :type="answers[String(question.id)] === '__other__' ? 'primary' : 'default'" @click="chooseAnswer(question, '__other__')">其他</NButton>
                  </NSpace>
                  <NInput v-if="question.isOther && answers[String(question.id)] === '__other__'" v-model:value="otherAnswers[String(question.id)]" :input-props="noSpellcheckInputProps" placeholder="请输入其他答案" />
                </template>
                <NInput v-else v-model:value="answers[String(question.id)]" :input-props="noSpellcheckInputProps" :type="question.isSecret ? 'password' : 'textarea'" :show-password-on="question.isSecret ? 'click' : undefined" />
              </NFormItem>
            </NForm>
            <NAlert v-if="formError" type="error">{{ formError }}</NAlert>
            <div v-if="showAnswerSubmit" class="approval-actions"><NButton type="primary" @click="submitAnswers">提交回答</NButton></div>
          </template>

          <template v-else-if="activeRequest.method === 'mcpServer/elicitation/request'">
            <NButton v-if="params.mode === 'url' && params.url" secondary type="warning" @click="openElicitationUrl">
              在浏览器中打开 {{ elicitationHost }}
            </NButton>
            <NForm v-else-if="params.mode === 'form'" label-placement="top">
              <NFormItem v-for="field in elicitationFields" :key="field.name" :label="`${String(field.schema.title ?? field.name)}${field.required ? ' *' : ''}`" :feedback="String(field.schema.description ?? '')">
                <NSwitch v-if="field.schema.type === 'boolean'" :value="fieldBooleanValue(field.name)" @update:value="updateField(field.name, $event)" />
                <NInputNumber v-else-if="field.schema.type === 'number' || field.schema.type === 'integer'" :value="fieldNumberValue(field.name)" :precision="field.schema.type === 'integer' ? 0 : undefined" :min="field.schema.minimum as number | undefined" :max="field.schema.maximum as number | undefined" @update:value="updateField(field.name, $event)" />
                <NSpace v-else-if="fieldOptions(field.schema).length && field.schema.type !== 'array'" vertical><NButton v-for="option in fieldOptions(field.schema)" :key="option.value" :type="fieldSelectValue(field.name) === option.value ? 'primary' : 'default'" @click="chooseElicitationOption(field, option.value)">{{ option.label }}</NButton></NSpace>
                <NSelect v-else-if="fieldOptions(field.schema).length" :value="fieldSelectValue(field.name)" multiple :options="fieldOptions(field.schema)" @update:value="updateField(field.name, $event)" />
                <NInput v-else :value="fieldStringValue(field.name)" :input-props="noSpellcheckInputProps" :type="field.schema.format === 'password' ? 'password' : 'text'" :maxlength="field.schema.maxLength as number | undefined" @update:value="updateField(field.name, $event)" />
              </NFormItem>
            </NForm>
            <NFormItem v-else-if="params.mode !== 'url'" label="扩展表单内容（JSON）">
              <NInput v-model:value="formJson" type="textarea" :input-props="noSpellcheckInputProps" :autosize="{ minRows: 5, maxRows: 14 }" />
            </NFormItem>
            <NAlert v-if="formError" type="error">{{ formError }}</NAlert>
            <NSpace class="approval-actions">
              <NButton v-if="params.mode === 'url' || !selectionOnlyElicitation" type="primary" @click="submitElicitation('accept')">{{ params.mode === 'url' ? '已完成，继续' : '提交' }}</NButton>
              <NButton type="error" secondary @click="submitElicitation('decline')">拒绝</NButton>
              <NButton @click="submitElicitation('cancel')">取消</NButton>
            </NSpace>
          </template>

          <template v-else-if="activeRequest.method === 'item/permissions/requestApproval'">
            <NAlert type="warning">仅勾选完成当前任务所必需的权限；“本会话允许”会持续到当前会话结束。</NAlert>
            <div class="approval-risk-summary">
              <div v-if="networkPermission.enabled !== undefined && networkPermission.enabled !== null"><strong>网络：</strong>{{ networkPermission.enabled ? "允许联网" : "保持禁用" }}</div>
              <div v-for="(entry, index) in filePermissionEntries" :key="index"><strong>{{ entry.access }}：</strong>{{ displayPath(entry.path) }}</div>
              <div v-if="!Object.keys(networkPermission).length && !filePermissionEntries.length">Codex 未提供可读的权限范围，请谨慎决定。</div>
            </div>
            <NSpace>
              <NCheckbox v-if="(params.permissions as Record<string, unknown>)?.network" v-model:checked="permissionSelection.network">允许请求的网络范围</NCheckbox>
              <NCheckbox v-if="(params.permissions as Record<string, unknown>)?.fileSystem" v-model:checked="permissionSelection.fileSystem">允许请求的文件范围</NCheckbox>
            </NSpace>
            <NSpace class="approval-actions">
              <NButton type="primary" @click="acceptPermissions('turn')">本轮允许</NButton>
              <NButton type="warning" secondary @click="acceptPermissions('session')">本会话允许</NButton>
              <NButton type="error" secondary @click="emit('resolve', activeRequest, { permissions: {}, scope: 'turn' })">拒绝</NButton>
            </NSpace>
          </template>

          <template v-else-if="['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'applyPatchApproval', 'execCommandApproval'].includes(activeRequest.method)">
            <NAlert v-if="params.additionalPermissions || params.networkApprovalContext || params.grantRoot" type="warning">此操作需要扩大当前权限范围。请核对目标、目录和持续时间后再允许。</NAlert>
            <div v-if="requestedCommandActions.length || requestedFileChanges.length || Object.keys(permissionProfile).length || params.proposedExecpolicyAmendment || params.proposedNetworkPolicyAmendments" class="approval-risk-summary">
              <div v-for="(action, index) in requestedCommandActions" :key="`action-${index}`"><strong>操作 {{ index + 1 }}：</strong>{{ commandActionLabel(action) }}</div>
              <div v-for="entry in requestedFileChanges" :key="entry.path"><strong>{{ fileChangeLabel(entry.change) }}：</strong>{{ entry.path }}<span v-if="entry.change.move_path"> → {{ entry.change.move_path }}</span></div>
              <div v-if="networkPermission.enabled"><strong>附加权限：</strong>允许联网</div>
              <div v-for="(entry, index) in filePermissionEntries" :key="`permission-${index}`"><strong>附加{{ entry.access }}：</strong>{{ displayPath(entry.path) }}</div>
              <div v-if="params.proposedExecpolicyAmendment"><strong>命令规则：</strong>{{ safeJson(params.proposedExecpolicyAmendment) }}</div>
              <div v-for="(amendment, index) in (params.proposedNetworkPolicyAmendments as unknown[] ?? [])" :key="`network-${index}`"><strong>网络规则：</strong>{{ (amendment as Record<string, unknown>).action }} {{ (amendment as Record<string, unknown>).host }}</div>
            </div>
            <NSpace class="approval-actions">
              <NButton v-for="(decision, index) in availableDecisions" :key="index" :type="decisionType(decision)" :secondary="decision !== 'accept'" @click="resolveDecision(decision)">
                {{ decisionLabel(decision) }}
              </NButton>
            </NSpace>
          </template>

          <template v-else>
            <NAlert type="error">此版本未注册该客户端能力。为避免未经确认的外部操作，请安全拒绝。</NAlert>
            <pre class="request-json">{{ safeJson(params) }}</pre>
            <div class="approval-actions"><NButton type="error" secondary @click="rejectUnsupported">安全拒绝此请求</NButton></div>
          </template>

        </NSpace>
        </NSpin>
  </section>
</template>
