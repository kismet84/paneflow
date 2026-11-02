<script setup lang="ts" generic="TItem">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  items: TItem[];
  itemKey: (item: TItem) => string;
  estimateSize?: (item: TItem) => number;
  minItemSize?: number;
  buffer?: number;
  followTail?: boolean;
}>(), { minItemSize: 56, buffer: 160 });
const emit = defineEmits<{ scroll: [event: Event] }>();
defineSlots<{ default: (props: { item: TItem; index: number }) => unknown; before?: () => unknown; empty?: () => unknown }>();

const TAIL_GAP_EPSILON = 2;
const TAIL_SNAP_DISTANCE = 32;

class FenwickTree {
  readonly values: number[];
  readonly tree: number[];

  constructor(values: number[]) {
    this.values = [...values];
    this.tree = Array(values.length + 1).fill(0);
    values.forEach((value, index) => {
      const cursor = index + 1;
      this.tree[cursor] = (this.tree[cursor] ?? 0) + value;
      const parent = cursor + (cursor & -cursor);
      if (parent < this.tree.length) this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[cursor] ?? 0);
    });
  }

  add(index: number, delta: number): void {
    this.values[index] = (this.values[index] ?? 0) + delta;
    for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] = (this.tree[cursor] ?? 0) + delta;
  }

  prefix(count: number): number {
    let result = 0;
    for (let cursor = Math.min(count, this.values.length); cursor > 0; cursor -= cursor & -cursor) result += this.tree[cursor] ?? 0;
    return result;
  }

  total(): number {
    return this.prefix(this.values.length);
  }

  indexAt(offset: number): number {
    if (!this.values.length) return 0;
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.values.length) step *= 2;
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next <= this.values.length && sum + (this.tree[next] ?? 0) <= offset) {
        index = next;
        sum += this.tree[next] ?? 0;
      }
    }
    return Math.min(index, this.values.length - 1);
  }
}

const scroller = ref<HTMLElement | null>(null);
const startIndex = ref(0);
const endIndex = ref(0);
const topSpacer = ref(0);
const bottomSpacer = ref(0);
const measuredSizes = new Map<string, number>();
let keyIndexes = new Map<string, number>();
let sizes = new FenwickTree([]);
let rangeFrame: number | null = null;
let tailFrame: number | null = null;
let rowObserver: ResizeObserver | null = null;
let widthObserver: ResizeObserver | null = null;
let observedWidth = 0;
let currentAnchorKey: string | null = null;
let currentViewportAnchorKey: string | null = null;
let currentViewportAnchorOffset = 0;
let tailDetached = false;
let lastScrollTop = 0;
const observedRows = new Map<string, Element>();

const visibleItems = computed(() => props.items.slice(startIndex.value, endIndex.value));
const estimatedSize = (item: TItem): number => Math.max(props.minItemSize, props.estimateSize?.(item) ?? props.minItemSize);
const followsTail = (): boolean => props.followTail && !tailDetached;
const pinToBottom = (element: HTMLElement): void => {
  setScrollTop(element, element.scrollHeight);
  lastScrollTop = element.scrollTop;
};
const scheduleTailPin = (force = false): void => {
  if (tailFrame !== null) cancelAnimationFrame(tailFrame);
  tailFrame = requestAnimationFrame(async () => {
    tailFrame = null;
    const element = scroller.value;
    if (!element || !force && !followsTail()) return;
    if (rangeFrame !== null) cancelAnimationFrame(rangeFrame);
    updateRange();
    await nextTick();
    if (element !== scroller.value || !force && !followsTail()) return;
    pinToBottom(element);
  });
};
const updateRange = (): void => {
  rangeFrame = null;
  const element = scroller.value;
  if (!element || !props.items.length) {
    startIndex.value = 0;
    endIndex.value = 0;
    topSpacer.value = 0;
    bottomSpacer.value = 0;
    return;
  }
  const overscan = Math.max(props.buffer, element.clientHeight);
  const viewportTop = element.scrollTop;
  const start = sizes.indexAt(Math.max(0, viewportTop - overscan));
  const end = followsTail()
    ? props.items.length
    : Math.min(props.items.length, sizes.indexAt(element.scrollTop + element.clientHeight + overscan) + 1);
  startIndex.value = start;
  endIndex.value = Math.max(start + 1, end);
  currentAnchorKey = props.itemKey(props.items[start]!);
  const viewportAnchorIndex = sizes.indexAt(element.scrollTop);
  currentViewportAnchorKey = props.itemKey(props.items[viewportAnchorIndex]!);
  currentViewportAnchorOffset = element.scrollTop - sizes.prefix(viewportAnchorIndex);
  topSpacer.value = sizes.prefix(start);
  bottomSpacer.value = Math.max(0, sizes.total() - sizes.prefix(endIndex.value));
};
const scheduleRangeUpdate = (): void => {
  if (rangeFrame === null) rangeFrame = requestAnimationFrame(updateRange);
};
const rebuild = async (): Promise<void> => {
  const element = scroller.value;
  const keepFollowing = followsTail();
  const anchorKey = keepFollowing ? null : currentViewportAnchorKey ?? currentAnchorKey;
  const anchorOffset = currentViewportAnchorKey ? currentViewportAnchorOffset : element ? element.scrollTop - sizes.prefix(startIndex.value) : 0;
  keyIndexes = new Map(props.items.map((item, index) => [props.itemKey(item), index]));
  for (const key of measuredSizes.keys()) {
    if (!keyIndexes.has(key)) measuredSizes.delete(key);
  }
  sizes = new FenwickTree(props.items.map((item) => measuredSizes.get(props.itemKey(item)) ?? estimatedSize(item)));
  if (element && anchorKey) {
    const nextAnchorIndex = keyIndexes.get(anchorKey);
    if (nextAnchorIndex !== undefined) setScrollTop(element, Math.max(0, sizes.prefix(nextAnchorIndex) + anchorOffset));
  }
  updateRange();
  await nextTick();
  if (element && keepFollowing && followsTail()) pinToBottom(element);
  else if (element && anchorKey) {
    const nextAnchorIndex = keyIndexes.get(anchorKey);
    if (nextAnchorIndex !== undefined) setScrollTop(element, Math.max(0, sizes.prefix(nextAnchorIndex) + anchorOffset));
  }
  scheduleRangeUpdate();
};
const observeRow = (element: Element | null, item: TItem): void => {
  if (!rowObserver) return;
  const key = props.itemKey(item);
  const previous = observedRows.get(key);
  if (!(element instanceof HTMLElement)) {
    if (previous) rowObserver.unobserve(previous);
    observedRows.delete(key);
    return;
  }
  if (previous && previous !== element) rowObserver.unobserve(previous);
  element.dataset.virtualKey = key;
  observedRows.set(key, element);
  rowObserver.observe(element);
};
const setScrollTop = (element: HTMLElement, position: number): void => {
  element.scrollTop = position;
};
const handleScroll = (event: Event): void => {
  const element = event.currentTarget as HTMLElement;
  const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
  const movedTowardTail = element.scrollTop > lastScrollTop + 0.5;
  if (gap <= TAIL_GAP_EPSILON) tailDetached = false;
  else if (movedTowardTail && gap <= TAIL_SNAP_DISTANCE) {
    tailDetached = false;
    scheduleTailPin(true);
  } else if (element.scrollTop < lastScrollTop - 0.5) tailDetached = true;
  lastScrollTop = element.scrollTop;
  scheduleRangeUpdate();
  emit("scroll", event);
};
const handleWheel = (event: WheelEvent): void => {
  if (event.deltaY < 0) tailDetached = true;
};
const scrollToBottom = (force = true): void => {
  if (!scroller.value) return;
  if (force) tailDetached = false;
  if (!force && !followsTail()) return;
  pinToBottom(scroller.value);
  scheduleTailPin(force);
  scheduleRangeUpdate();
};
const scrollToPosition = (position: number): void => {
  if (!scroller.value) return;
  tailDetached = scroller.value.scrollHeight - position - scroller.value.clientHeight >= TAIL_GAP_EPSILON;
  setScrollTop(scroller.value, Math.max(0, position));
  lastScrollTop = scroller.value.scrollTop;
  scheduleRangeUpdate();
};

watch(() => [props.items, props.items.length, props.items[0] ? props.itemKey(props.items[0]) : null, props.items.at(-1) ? props.itemKey(props.items.at(-1)!) : null] as const, rebuild);
onMounted(() => {
  if (typeof ResizeObserver === "undefined") {
    void rebuild();
    return;
  }
  rowObserver = new ResizeObserver((entries) => {
    const element = scroller.value;
    let changed = false;
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset.virtualKey;
      if (!key) continue;
      const index = keyIndexes.get(key);
      if (index === undefined || props.itemKey(props.items[index]!) !== key) continue;
      const nextSize = Math.max(props.minItemSize, Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height));
      const previousSize = sizes.values[index] ?? estimatedSize(props.items[index]!);
      if (nextSize === previousSize) continue;
      measuredSizes.set(key, nextSize);
      sizes.add(index, nextSize - previousSize);
      changed = true;
    }
    if (element && changed && followsTail()) scheduleTailPin();
    scheduleRangeUpdate();
  });
  widthObserver = new ResizeObserver((entries) => {
    const width = Math.round(entries[0]?.contentRect.width ?? 0);
    if (!width || width === observedWidth) return;
    if (observedWidth) measuredSizes.clear();
    observedWidth = width;
    void rebuild();
  });
  if (scroller.value) widthObserver.observe(scroller.value);
  void rebuild();
});
onBeforeUnmount(() => {
  if (rangeFrame !== null) cancelAnimationFrame(rangeFrame);
  if (tailFrame !== null) cancelAnimationFrame(tailFrame);
  rowObserver?.disconnect();
  widthObserver?.disconnect();
  observedRows.clear();
});
defineExpose({ scrollToBottom, scrollToPosition });
</script>

<template>
  <div ref="scroller" :data-total-items="items.length" :data-range-start="startIndex" :data-range-end="endIndex" @scroll.passive="handleScroll" @wheel.passive="handleWheel">
    <div v-if="$slots.before" class="virtual-list-overlay"><slot name="before" /></div>
    <slot v-if="!items.length" name="empty" />
    <div class="virtual-list-spacer" :style="{ height: `${topSpacer}px` }" />
    <div v-for="(item, offset) in visibleItems" :key="itemKey(item)" :ref="element => observeRow(element as Element | null, item)">
      <slot :item="item" :index="startIndex + offset" />
    </div>
    <div class="virtual-list-spacer" :style="{ height: `${bottomSpacer}px` }" />
  </div>
</template>

<style scoped>
.virtual-list-overlay { position: sticky; top: 0; z-index: 2; height: 0; overflow: visible; }
.virtual-list-spacer { flex: 0 0 auto; width: 1px; pointer-events: none; }
</style>
