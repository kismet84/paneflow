import { describe, expect, it } from "vitest";
import { toWebSocketUrl } from "../../electron/main/relay-connection";

describe("relay connection URL", () => {
  it("keeps an optional base path when creating the WebSocket URL", () => {
    expect(toWebSocketUrl("https://pane.example.com")).toBe("wss://pane.example.com/ws");
    expect(toWebSocketUrl("https://pane.example.com/codex-pane-relay")).toBe("wss://pane.example.com/codex-pane-relay/ws");
    expect(toWebSocketUrl("http://localhost:3000/teams/remote/")).toBe("ws://localhost:3000/teams/remote/ws");
  });
});
