export type WindowRectangle = { x: number; y: number; width: number; height: number };
export type SavedWindowBounds = { x?: number; y?: number; width: number; height: number };

const intersectionArea = (left: WindowRectangle, right: WindowRectangle): number => {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
};

export const fitWindowBounds = (saved: SavedWindowBounds, workAreas: WindowRectangle[], primaryIndex = 0): SavedWindowBounds => {
  const fallback = workAreas[primaryIndex] ?? workAreas[0];
  if (!fallback) return { width: Math.max(960, saved.width), height: Math.max(680, saved.height) };
  const requested = { x: saved.x ?? fallback.x, y: saved.y ?? fallback.y, width: saved.width, height: saved.height };
  const best = workAreas.map((area) => ({ area, overlap: intersectionArea(requested, area) })).sort((left, right) => right.overlap - left.overlap)[0];
  const target = best && best.overlap >= 80 * 80 ? best.area : fallback;
  const width = Math.min(Math.max(960, saved.width), target.width);
  const height = Math.min(Math.max(680, saved.height), target.height);
  if (!best || best.overlap < 80 * 80 || saved.x === undefined || saved.y === undefined) return { width, height };
  return {
    width,
    height,
    x: Math.min(Math.max(saved.x, target.x), target.x + target.width - width),
    y: Math.min(Math.max(saved.y, target.y), target.y + target.height - height)
  };
};
