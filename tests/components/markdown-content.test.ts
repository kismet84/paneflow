// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { NDialogProvider } from "naive-ui";
import { h } from "vue";
import { describe, expect, it, vi } from "vitest";
import MarkdownContent from "../../src/components/MarkdownContent.vue";

describe("MarkdownContent links", () => {
  it("opens agent reply links only with Ctrl+click", async () => {
    const openExternal = vi.fn(async () => undefined);
    window.codexPane = { openExternal } as unknown as Window["codexPane"];
    const wrapper = mount(NDialogProvider, {
      slots: { default: () => h(MarkdownContent, { source: "https://example.com/result", ctrlClickLinks: true }) }
    });
    await vi.waitFor(() => expect(wrapper.find("a").exists()).toBe(true));

    await wrapper.get("a").trigger("click");
    expect(openExternal).not.toHaveBeenCalled();
    await wrapper.get("a").trigger("click", { ctrlKey: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/result");
  });

  it("allows Ctrl+click for HTTP links", async () => {
    const openExternal = vi.fn(async () => undefined);
    window.codexPane = { openExternal } as unknown as Window["codexPane"];
    const wrapper = mount(NDialogProvider, {
      slots: { default: () => h(MarkdownContent, { source: "http://localhost:3000/status", ctrlClickLinks: true }) }
    });

    await wrapper.get("a").trigger("click", { ctrlKey: true });
    expect(openExternal).toHaveBeenCalledWith("http://localhost:3000/status");
  });
});
