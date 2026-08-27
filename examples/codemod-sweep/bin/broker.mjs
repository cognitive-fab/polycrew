// A broker that outlives the agents.
//
// This is the piece a sweep cannot do without, and the reason is worth
// understanding before you copy this script.
//
// Every `claude -p` invocation spawns its OWN polycrew process, and the first
// one to start becomes the crew's broker. A work order's parked handler lives
// in the broker's memory — the ORDER is in SQLite and survives anything, but
// the promise the engine is waiting on is not. So when the planner agent
// exits, its broker dies with it, and the workers that start afterwards find
// their orders still open and still claimable, but with nothing left to report
// TO. Every report comes back `order-expired`, and the changes they made on
// disk never get recorded.
//
// (The engine does recover on its own: polyrun's effect lease expires, the
// handler re-runs, and the order is re-offered at a higher attempt. But that
// lease is minutes long, and a worker that finishes in seconds is long gone.)
//
// So the sweep starts one process whose only job is to hold the port and the
// parked handlers for the whole run. Every agent then proxies to it, and the
// broker outlives all of them.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLYCREW = resolve(HERE, '..', '..', '..');

const child = spawn(process.execPath, ['--no-warnings', join(POLYCREW, 'bin', 'polycrew.mjs')], {
  // stdin is a pipe we open and never close: the MCP server reads it, and an
  // EOF there would shut the broker down the moment this wrapper looked away.
  stdio: ['pipe', 'ignore', 'inherit'],
  env: process.env,
});

// Ref'd on purpose. polycrew unrefs its own handles so that an agent's session
// never hangs at exit, which means nothing else here would keep this process
// alive — and this process is the entire point.
const keepAlive = setInterval(() => {}, 1 << 30);

const stop = () => {
  clearInterval(keepAlive);
  child.kill();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  clearInterval(keepAlive);
  process.exit(code ?? 0);
});
