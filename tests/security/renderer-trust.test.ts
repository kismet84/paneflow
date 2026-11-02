import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl, rendererEntryUrl } from "../../electron/main/renderer-trust";

describe("renderer trust boundary", () => {
  it("trusts only the exact bundled renderer entry", () => {
    const entry = rendererEntryUrl("E:\\Personal\\codex-pane", true);
    expect(isTrustedRendererUrl(entry, entry)).toBe(true);
    expect(isTrustedRendererUrl(`${entry}#settings`, entry)).toBe(true);
    expect(isTrustedRendererUrl("file:///E:/Personal/codex-pane/data/other.html", entry)).toBe(false);
    expect(isTrustedRendererUrl("file:///C:/Users/Public/index.html", entry)).toBe(false);
  });

  it("rejects lookalike development origins and paths", () => {
    const entry = rendererEntryUrl("E:\\Personal\\codex-pane", false);
    expect(isTrustedRendererUrl(entry, entry)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/index.html", entry)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173.evil.test/", entry)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5173/", entry)).toBe(false);
    expect(isTrustedRendererUrl("not a url", entry)).toBe(false);
  });
});
