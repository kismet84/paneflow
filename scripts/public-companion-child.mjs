import { spawn } from 'node:child_process';
// The IPC channel, not a recyclable PID, proves the owner's lifetime.
let child, stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  if (!child || child.exitCode !== null) process.exit(0);
  child.kill(); // Exact owned child only; never kill a process tree or shared MCP service.
};
process.on('disconnect', stop);
process.on('message', message => {
  if (message?.type === 'stop') { stop(); return; }
  if (message?.type !== 'start' || child || stopping) return;
  child = spawn(message.executable, message.args, { cwd: message.cwd, env: message.env, windowsHide: true, stdio: ['ignore','inherit','inherit'] });
  if (child.pid) process.send?.({type:'started',pid:child.pid});
  child.once('error', error => { console.error(error.code); process.exit(1); });
  child.once('exit', code => process.exit(stopping ? 0 : (code ?? 1)));
});
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, stop);
