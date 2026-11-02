// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteClient } from "./remote-client";

describe("RemoteClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses only the parent Bootloader transport", () => {
    const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
    const client = new RemoteClient(() => undefined, () => undefined);
    client.start();
    const requestId = crypto.randomUUID();
    client.send({ type: "turn.send", requestId, threadId: "thread-1", text: "继续" });
    expect(postMessage).toHaveBeenCalledWith({ source: "codex-pane-mobile-ui", type: "ready" }, "*");
    expect(postMessage).toHaveBeenCalledWith({ source: "codex-pane-mobile-ui", type: "command", command: expect.objectContaining({ type: "snapshot.get" }) }, "*");
    expect(postMessage).toHaveBeenCalledWith({ source: "codex-pane-mobile-ui", type: "command", command: { type: "turn.send", requestId, threadId: "thread-1", text: "继续" } }, "*");
  });

  it("accepts validated desktop events only from the parent", () => {
    const events: unknown[] = [];
    const client = new RemoteClient((event) => events.push(event), () => undefined);
    client.start();
    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent,
      data: { source: "codex-pane-bootstrap", type: "event", event: { type: "notice", seq: 1, level: "info", message: "已连接" } }
    }));
    expect(events).toEqual([{ type: "notice", seq: 1, level: "info", message: "已连接" }]);
  });

  it("does not report the transport as disconnected for one incompatible event", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const states: unknown[] = [];
    const client = new RemoteClient(() => undefined, (state, message) => states.push({ state, message }));
    client.start();
    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent,
      data: { source: "codex-pane-bootstrap", type: "event", event: { type: "notice", seq: 0, level: "info", message: "无效事件" } }
    }));
    expect(states.at(-1)).toEqual({ state: "connected", message: "桌面消息格式不兼容，请更新桌面端" });
  });
});
