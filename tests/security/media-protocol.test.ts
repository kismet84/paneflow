import { describe, expect, it } from "vitest";
import { mediaRequestId } from "../../electron/main/media-protocol";

describe("managed media protocol", () => {
  const id = "0d811659-c9df-5f14-8abc-6f6f971f2967";

  it("accepts only exact GET requests for managed image ids", () => {
    expect(mediaRequestId(`codex-media://media/${id}`, "GET")).toBe(id);
    expect(mediaRequestId(`codex-media://other/${id}`, "GET")).toBeNull();
    expect(mediaRequestId(`codex-media://media/${id}?download=1`, "GET")).toBeNull();
    expect(mediaRequestId(`codex-media://media/${id}`, "POST")).toBeNull();
    expect(mediaRequestId("codex-media://media/../../workspace.json", "GET")).toBeNull();
  });
});
