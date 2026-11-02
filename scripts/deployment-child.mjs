import { spawn } from "node:child_process";

// This watchdog owns exactly one child. Loss of the desktop IPC parent must never orphan it.
const [role, executable, ...args] = process.argv.slice(2);
if (!process.send || !["relay", "tunnel"].includes(role) || !executable) process.exit(2);
let stopping = false;
let exited = false;
let forceTimer;
const child = spawn(executable, args, {
  cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
  stdio: role === "relay" ? ["ignore", "ignore", "ignore", "ipc"] : "ignore"
});
const send = value => { if (process.connected) { try { process.send(value); } catch {} } };
const stop = () => {
  if (stopping || exited) return;
  stopping = true;
  try { child.kill(); } catch {}
  forceTimer = setTimeout(() => { if (!exited) { try { child.kill("SIGKILL"); } catch {} } }, 2000);
  // Do not exit the watchdog until the owned child actually exits.
};
child.once("spawn", () => send({ type: "deployment.child.started", role, pid: child.pid }));
child.on("message", message => {
  if (role === "relay" && message?.type === "relay.ready" && Number.isInteger(message.port)) send({ type: "relay.ready", port: message.port });
});
child.once("error", () => { send({ type: "deployment.child.error", role }); stop(); });
child.once("exit", code => {
  exited = true; if (forceTimer) clearTimeout(forceTimer);
  process.exit(stopping ? 0 : code ?? 1);
});
// spawn errors may have no exit event. close proves that no live child handle remains.
child.once("close", code => { if (!exited) { exited = true; if (forceTimer) clearTimeout(forceTimer); process.exit(stopping ? 0 : code ?? 1); } });
process.on("message", message => { if (message?.type === "deployment.stop") stop(); });
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
if (!process.connected) stop();
