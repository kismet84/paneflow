import { describe, expect, it } from "vitest";
import { isNearConversationBottom } from "./scroll";

describe("mobile conversation scrolling", () => {
  it("tolerates fractional and small bottom layout errors", () => {
    expect(isNearConversationBottom(1_000.5, 600, 400)).toBe(true);
    expect(isNearConversationBottom(1_056, 600, 400)).toBe(true);
  });

  it("does not force following while the user reads older content", () => {
    expect(isNearConversationBottom(2_000, 600, 400)).toBe(false);
  });
});
