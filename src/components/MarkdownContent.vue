<script setup lang="ts">
import { ref, watch } from "vue";
import { useDialog } from "naive-ui";
import "highlight.js/styles/atom-one-dark.css";
import { renderCachedMarkdown } from "../markdown";

const props = withDefaults(defineProps<{ source: string; streaming?: boolean; ctrlClickLinks?: boolean }>(), { streaming: false, ctrlClickLinks: false });
const dialog = useDialog();

const html = ref("");
const scheduleRender = (): void => {
  html.value = props.streaming ? "" : renderCachedMarkdown(props.source);
};

watch(() => [props.source, props.streaming] as const, scheduleRender, { immediate: true });

const handleClick = async (event: MouseEvent): Promise<void> => {
  const target = event.target instanceof Element ? event.target.closest("a") : null;
  if (!target) return;
  event.preventDefault();
  if (props.ctrlClickLinks && !event.ctrlKey) return;
  const href = target.getAttribute("href");
  if (!href) return;
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol)) {
      dialog.warning({ title: "无法打开链接", content: "PaneFlow Desktop 只允许通过系统浏览器打开 HTTP 或 HTTPS 链接。", positiveText: "知道了" });
      return;
    }
    try {
      await window.codexPane.openExternal(url.toString());
    } catch (error) {
      dialog.error({ title: "无法打开链接", content: error instanceof Error ? error.message : String(error), positiveText: "知道了" });
    }
  } catch {
    dialog.warning({ title: "无法打开链接", content: "这个链接格式无效。", positiveText: "知道了" });
  }
};
</script>

<template>
  <pre v-if="streaming || !html" class="markdown-content markdown-streaming">{{ source }}</pre>
  <div v-else class="markdown-content" @click="handleClick" v-html="html" />
</template>

<style scoped>
.markdown-streaming { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style>
