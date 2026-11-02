import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const TOTAL_ITEMS_PER_PANE = 124 * 64;

const createWorkspace = async (userDataPath: string): Promise<void> => {
  const workspacePath = resolve(userDataPath, "workspaces", "default.json");
  await mkdir(dirname(workspacePath), { recursive: true });
  await writeFile(workspacePath, JSON.stringify({
    version: 1,
    layout: "six",
    splitSizes: {},
    defaultCwd: "E:\\AI-Workspace",
    appearance: {
      theme: "dark",
      fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
      fontSize: 14,
      accentColor: "#10a37f",
      commandShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      unwrapPowerShellCommands: true,
      mcpGatewayAdaptation: false
    },
    focusedPaneId: null,
    panes: Array.from({ length: 6 }, (_, index) => ({
      id: `pane-${index + 1}`,
      threadId: `performance-thread-${index + 1}`,
      cwd: "E:\\AI-Workspace",
      draft: "",
      attachments: [],
      references: [],
      model: null,
      effort: null,
      scrollTop: 0,
      followTail: true
    })),
    window: { width: 1480, height: 920, maximized: false }
  }), "utf8");
};

const frameMetrics = async (window: Page, animateScroll: boolean, frameCount = 240) => window.evaluate(async ({ animate, frames }) => {
  const scrollers = [...document.querySelectorAll<HTMLElement>(".pane-output")];
  const frameDurations: number[] = [];
  let previous = performance.now();
  await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolveFrame) => requestAnimationFrame((timestamp) => {
      if (frame >= 20) frameDurations.push(timestamp - previous);
      previous = timestamp;
      if (animate) {
        scrollers.forEach((scroller, index) => {
          const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.scrollTop = maximum ? (scroller.scrollTop + 80 + index * 8) % maximum : 0;
        });
      }
      resolveFrame();
    }));
  }
  const sorted = [...frameDurations].sort((left, right) => left - right);
  return {
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maximum: sorted.at(-1) ?? 0,
    droppedFrames: frameDurations.filter((duration) => duration > 34).length,
    longFrames: frameDurations.filter((duration) => duration > 50).length
  };
  }, { animate: animateScroll, frames: frameCount });

test("keeps the longest-session shape smooth across six panes", async () => {
  test.setTimeout(180_000);
  const userDataPath = resolve("test-results", `performance-user-data-${randomUUID()}`);
  await createWorkspace(userDataPath);
  const application = await electron.launch({
    args: ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle", resolve(".")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      CODEX_PANE_LOAD_DIST: "1",
      CODEX_PANE_PERFORMANCE_FIXTURE: "1",
      CODEX_PANE_USER_DATA_DIR: userDataPath
    }
  });
  application.process().stdout?.on("data", (data) => process.stdout.write(`[performance:stdout] ${String(data)}`));
  application.process().stderr?.on("data", (data) => process.stdout.write(`[performance:stderr] ${String(data)}`));
  try {
    const window = await application.firstWindow();
    await expect(window.locator(".pane")).toHaveCount(6);
    await expect.poll(async () => window.locator(".pane-output").evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-total-items"))))).toEqual(Array(6).fill(12 * 64));

    for (let page = 0; page < 12; page += 1) {
      const totals = await window.locator(".pane-output").evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-total-items"))));
      if (totals.every((total) => total === TOTAL_ITEMS_PER_PANE)) break;
      await window.locator(".pane-output").evaluateAll((elements) => {
        for (const element of elements) {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        }
      });
      await expect.poll(async () => Math.min(...await window.locator(".pane-output").evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-total-items"))))), { timeout: 10_000 }).toBeGreaterThan(Math.min(...totals));
    }

    const totals = await window.locator(".pane-output").evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-total-items"))));
    expect(totals).toEqual(Array(6).fill(TOTAL_ITEMS_PER_PANE));
    const mountedItems = await window.locator(".conversation-item").count();
    expect(mountedItems).toBeGreaterThan(0);
    expect(mountedItems).toBeLessThan(300);

    const upwardScroll = await window.locator(".pane-output").first().evaluate(async (element) => {
      element.scrollTop = element.scrollHeight;
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
      const start = element.scrollTop;
      let previous = start;
      let reversals = 0;
      for (let frame = 0; frame < 40; frame += 1) {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -60 }));
        element.scrollTop = Math.max(0, element.scrollTop - 60);
        await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        if (element.scrollTop > previous + 1) reversals += 1;
        previous = element.scrollTop;
      }
      const renderedRows = [...element.querySelectorAll<HTMLElement>("[data-virtual-key]")];
      const renderedBottom = renderedRows.at(-1)?.getBoundingClientRect().bottom ?? 0;
      const viewportBottom = element.getBoundingClientRect().bottom;
      return { start, end: element.scrollTop, reversals, retainedBelowViewport: renderedBottom - viewportBottom };
    });
    expect(upwardScroll.reversals).toBe(0);
    expect(upwardScroll.end).toBeLessThan(upwardScroll.start - 1_000);
    expect(upwardScroll.retainedBelowViewport).toBeGreaterThan(100);

    const downwardScroll = await window.locator(".pane-output").first().evaluate(async (element) => {
      let previous = element.scrollTop;
      let reversals = 0;
      for (let frame = 0; frame < 80; frame += 1) {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
        element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + 120);
        await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        if (element.scrollTop < previous - 1) reversals += 1;
        previous = element.scrollTop;
        if (element.scrollHeight - element.clientHeight - element.scrollTop <= 1) break;
      }
      return { reversals, gap: element.scrollHeight - element.clientHeight - element.scrollTop };
    });
    expect(downwardScroll.reversals).toBe(0);
    expect(downwardScroll.gap).toBeLessThanOrEqual(1.1);

    const idleFrames = await frameMetrics(window, false);
    process.stdout.write(`[performance:idle] ${JSON.stringify(idleFrames)}\n`);
    const scrollFrames = await frameMetrics(window, true);
    process.stdout.write(`[performance:scroll] ${JSON.stringify(scrollFrames)}\n`);
    expect(scrollFrames.p95).toBeLessThanOrEqual(Math.max(20, idleFrames.p95 + 4));
    expect(scrollFrames.droppedFrames).toBe(0);
    expect(scrollFrames.longFrames).toBeLessThanOrEqual(idleFrames.longFrames);

    await window.locator(".pane-output").evaluateAll((elements) => {
      for (const element of elements) element.scrollTop = element.scrollHeight;
    });
    for (let index = 0; index < 6; index += 1) {
      const composer = window.locator(`[data-pane-id="pane-${index + 1}"] textarea`);
      await composer.fill(`性能流式测试 ${index + 1}`);
    }
    await window.locator(".pane textarea").evaluateAll((composers) => {
      for (const composer of composers) composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const streamingFrames = await frameMetrics(window, false);
    process.stdout.write(`[performance:streaming] ${JSON.stringify(streamingFrames)}\n`);
    expect(streamingFrames.p95).toBeLessThanOrEqual(20);
    expect(streamingFrames.droppedFrames).toBe(0);
    expect(streamingFrames.longFrames).toBe(0);
    const detachedStreamingPosition = await window.locator(".pane-output").first().evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -160 }));
      element.scrollTop = Math.max(0, element.scrollTop - 160);
      return element.scrollTop;
    });
    await window.waitForTimeout(500);
    const detachedStreamingEnd = await window.locator(".pane-output").first().evaluate((element) => element.scrollTop);
    expect(detachedStreamingEnd).toBeLessThanOrEqual(detachedStreamingPosition + 1);

    await window.locator(".pane textarea").evaluateAll((composers) => {
      for (const composer of composers) composer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => window.locator(".pane-output").evaluateAll((elements) => elements.every((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 1.1)), { timeout: 10_000 }).toBe(true);
  } finally {
    await application.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
