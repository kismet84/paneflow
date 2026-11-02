// @vitest-environment jsdom

import { h } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualList from "../../src/components/VirtualList.vue";

describe("VirtualList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("keeps a ten-thousand-item conversation bounded to the visible window", async () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: {
        items,
        itemKey: (item: unknown) => (item as { id: string }).id,
        estimateSize: () => 64,
        minItemSize: 56,
        buffer: 160
      },
      slots: {
        default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text)
      }
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("data-total-items")).toBe("10000");
    expect(wrapper.findAll(".virtual-row").length).toBeGreaterThan(0);
    expect(wrapper.findAll(".virtual-row").length).toBeLessThan(50);
  });

  it("preserves the visible anchor when an older page is prepended", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: {
        items,
        itemKey: (item: unknown) => (item as { id: string }).id,
        estimateSize: () => 64,
        minItemSize: 56,
        buffer: 160
      },
      slots: {
        default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text)
      }
    });
    const scroller = wrapper.element as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    scroller.scrollTop = 640;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const anchorText = wrapper.find(".virtual-row").text();

    const olderItems = Array.from({ length: 10 }, (_, index) => ({ id: `older-${index}`, text: `older ${index}` }));
    await wrapper.setProps({ items: [...olderItems, ...items] });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(wrapper.find(".virtual-row").text()).toBe(anchorText);
    expect(scroller.scrollTop).toBe(1_280);
  });

  it("does not force the scroll position while measured rows change height", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: { items, itemKey: (item: unknown) => (item as { id: string }).id, estimateSize: () => 64, minItemSize: 56, buffer: 160 },
      slots: { default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text) }
    });
    const scroller = wrapper.element as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    scroller.scrollTop = 640;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const rowsAboveViewport = wrapper.findAll("[data-virtual-key]").filter((row) => Number((row.attributes("data-virtual-key") ?? "").slice(5)) < 10).map((row) => row.element);
    callbacks[0]!(rowsAboveViewport.map((target) => ({ target, borderBoxSize: [{ blockSize: 100 }] })) as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(scroller.scrollTop).toBe(640);
    expect(wrapper.text()).toContain("message 10");
  });

  it("keeps at least one viewport mounted beyond the visible bottom edge", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: { items, itemKey: (item: unknown) => (item as { id: string }).id, estimateSize: () => 64, minItemSize: 56, buffer: 160 },
      slots: { default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text) }
    });
    const scroller = wrapper.element as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    scroller.scrollTop = 640;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(Number(wrapper.attributes("data-range-end"))).toBeGreaterThanOrEqual(21);
  });

  it("does not reattach streaming tail-follow after an upward wheel gesture", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: { items, itemKey: (item: unknown) => (item as { id: string }).id, estimateSize: () => 64, followTail: true },
      slots: { default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text) }
    });
    const scroller = wrapper.element as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 6_400 });
    scroller.scrollTop = 6_080;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -60 }));
    scroller.scrollTop = 6_020;
    scroller.dispatchEvent(new Event("scroll"));
    (wrapper.vm as unknown as { scrollToBottom: (force?: boolean) => void }).scrollToBottom(false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(scroller.scrollTop).toBe(6_020);
  });

  it("settles at the bottom when downward scrolling reaches the final small gap", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
    const wrapper = mount(VirtualList, {
      props: { items, itemKey: (item: unknown) => (item as { id: string }).id, estimateSize: () => 64, followTail: true },
      slots: { default: ({ item }: { item: unknown }) => h("article", { class: "virtual-row" }, (item as { text: string }).text) }
    });
    const scroller = wrapper.element as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 6_400 });
    scroller.scrollTop = 5_900;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -60 }));
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop = 6_060;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(scroller.scrollTop).toBe(6_400);
  });
});
