// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SessionDrawer from "../../src/components/SessionDrawer.vue";
import type { PaneState } from "../../src/types";

const pane = {
  id: "pane-1",
  threadId: null
} as PaneState;

describe("SessionDrawer", () => {
  it("switches between the current working directory and all sessions", async () => {
    const wrapper = mount(SessionDrawer, {
      props: {
        show: true,
        pane,
        threads: [],
        showAll: false,
        currentCwd: "E:\\AI-Workspace"
      },
      global: { stubs: { teleport: true } }
    });

    expect(wrapper.text()).toContain("仅显示：E:\\AI-Workspace");
    await wrapper.get(".session-scope-button").trigger("click");
    expect(wrapper.emitted("scope")).toEqual([[true, ""]]);

    await wrapper.setProps({ showAll: true });
    expect(wrapper.text()).toContain("正在显示所有工作目录");
    expect(wrapper.get(".session-scope-button").text()).toBe("仅当前目录");
  });

  it("shows a renamed session title with a preview that helps distinguish it", () => {
    const wrapper = mount(SessionDrawer, {
      props: {
        show: true,
        pane,
        threads: [{ id: "thread-1", name: "重命名标题", preview: "协议里的第二行预览", cwd: "E:\\Work", updatedAt: 1, status: "idle" }],
        showAll: true,
        currentCwd: "E:\\Work"
      },
      global: { stubs: { teleport: true } }
    });

    expect(wrapper.text()).toContain("重命名标题");
    expect(wrapper.text()).toContain("协议里的第二行预览");
    expect(wrapper.get(".session-preview").text()).toBe("协议里的第二行预览");
  });
});
