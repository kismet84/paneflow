import { describe, expect, it } from "vitest";
import { fitWindowBounds } from "../../electron/main/window-bounds";

const displays = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 2560, height: 1400 }
];

describe("saved window bounds", () => {
  it("restores a visible window inside its display", () => {
    expect(fitWindowBounds({ x: 2200, y: 100, width: 1400, height: 900 }, displays)).toEqual({ x: 2200, y: 100, width: 1400, height: 900 });
  });

  it("moves an off-screen or oversized window back to the primary display", () => {
    expect(fitWindowBounds({ x: 8000, y: -4000, width: 9000, height: 5000 }, displays)).toEqual({ width: 1920, height: 1040 });
  });

  it("keeps a partially visible window fully reachable", () => {
    expect(fitWindowBounds({ x: -200, y: -100, width: 1200, height: 800 }, displays)).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });
});
