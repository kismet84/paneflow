import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const wrappers: ChildProcess[] = [];
const watchdogPath = fileURLToPath(new URL("../../scripts/deployment-child.mjs", import.meta.url));
const launchFixture = async () => {
  const wrapper = spawn(process.execPath, [watchdogPath, "relay", process.execPath, "-e", "process.send({type:'relay.ready',port:48322});setInterval(()=>{},1000)"], { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  wrappers.push(wrapper);
  let childPid = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture readiness timeout")), 5000);
    wrapper.on("message", (message: any) => {
      if (message.type === "deployment.child.started") childPid = message.pid;
      if (message.type === "relay.ready") { clearTimeout(timer); resolve(); }
    });
    wrapper.once("error", error => { clearTimeout(timer); reject(error); });
  });
  expect(childPid).toBeGreaterThan(0);
  return { wrapper, childPid };
};
const exited = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
  if (child.exitCode !== null) { resolve(); return; }
  const timer = setTimeout(() => reject(new Error("watchdog did not finish child cleanup")), 7000);
  child.once("exit", () => { clearTimeout(timer); resolve(); });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => { await Promise.all(wrappers.splice(0).map(async wrapper => { if (wrapper.exitCode !== null) return; const done = exited(wrapper); if (wrapper.connected) wrapper.disconnect(); await done; })); });

describe("owned deployment child watchdog (fixture processes only)", () => {
  it("forwards relay readiness, cleans up its exact child on parent IPC disconnect, and permits a fresh launch", async () => {
    const first = await launchFixture(); expect(alive(first.childPid)).toBe(true);
    const firstExit = exited(first.wrapper); first.wrapper.disconnect(); await firstExit;
    expect(alive(first.childPid)).toBe(false);
    const second = await launchFixture(); expect(alive(second.childPid)).toBe(true);
    const secondExit = exited(second.wrapper); second.wrapper.send({ type: "deployment.stop" }); await secondExit;
    expect(alive(second.childPid)).toBe(false);
  }, 20000);
});
