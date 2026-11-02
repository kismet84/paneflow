import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';

// Exercise the actual launcher cleanup closure with an owned-process double.
// No ADB mapping or real process is changed by this check.
const source = await readFile(new URL('./start-usb-prototype.mjs', import.meta.url), 'utf8');
const start = source.indexOf('let stopPromise;');
const end = source.indexOf("for (const signal", start);
assert.ok(start >= 0 && end > start, 'launcher cleanup boundary changed');
const relay = new EventEmitter();
Object.assign(relay, { exitCode: null, pid: 1, connected: true });
let kills = 0;
let removals = 0;
relay.kill = () => { kills++; setTimeout(() => { relay.exitCode = 0; relay.emit('exit', 0); }, 20); };
relay.disconnect = () => { relay.connected = false; };
const stop = new Function('relay', 'forwarded', 'adb', 'serial', 'port', 'execFileSync', `${source.slice(start, end)}\nreturn stop;`)(
  relay, true, 'owned-adb', 'owned-phone', 48321,
  (command, args) => { assert.equal(command, 'owned-adb'); assert.deepEqual(args, ['-s', 'owned-phone', 'reverse', '--remove', 'tcp:48321']); removals++; }
);
const first = stop();
const second = stop();
assert.equal(first, second, 'repeated exit signals must await the same cleanup');
assert.equal(removals, 0, 'second signal must not bypass pending process cleanup');
await Promise.all([first, second]);
assert.equal(kills, 1);
assert.equal(removals, 1);
console.log('PASS repeated shutdown requests share completion and remove only the owned USB mapping once');
