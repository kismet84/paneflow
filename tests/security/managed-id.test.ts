import { describe, expect, it } from "vitest";
import { stableManagedId } from "../../electron/main/managed-id";

describe("stable managed attachment ids", () => {
  it("returns a deterministic UUID without exposing the source identity", () => {
    const first = stableManagedId("E:\\Work\\private\\notes.txt\0metadata");
    expect(first).toBe(stableManagedId("E:\\Work\\private\\notes.txt\0metadata"));
    expect(first).not.toContain("notes");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
