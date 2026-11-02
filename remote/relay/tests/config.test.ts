import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("relay configuration", () => {
  it("normalizes a root origin and keeps local HTTP development available", () => {
    expect(loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com/" }).PUBLIC_ORIGIN).toBe("https://pane.example.com");
    expect(loadConfig({ PUBLIC_ORIGIN: "http://localhost:3000" }).PUBLIC_ORIGIN).toBe("http://localhost:3000");
    expect(loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com" }).BASE_PATH).toBe("/");
  });

  it("normalizes an optional deployment base path", () => {
    expect(loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com", BASE_PATH: "/codex-pane-relay/" }).BASE_PATH).toBe("/codex-pane-relay");
    expect(loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com", BASE_PATH: "/teams/remote" }).BASE_PATH).toBe("/teams/remote");
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com", BASE_PATH: "codex-pane-relay" })).toThrow(/BASE_PATH/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://pane.example.com", BASE_PATH: "/relay?token=value" })).toThrow(/BASE_PATH/);
  });

  it.each([
    "http://pane.example.com",
    "https://user:secret@pane.example.com",
    "https://pane.example.com/relay",
    "https://pane.example.com?token=value",
    "https://pane.example.com/#mobile"
  ])("rejects a non-origin PUBLIC_ORIGIN: %s", (value) => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: value })).toThrow(/PUBLIC_ORIGIN/);
  });
});
