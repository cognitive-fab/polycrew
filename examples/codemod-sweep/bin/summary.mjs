// What the crew actually did — read from the crew's own store, not from what
// the agents said about themselves.
//
// It starts one more polycrew session (which becomes the broker, since the
// agents have exited), asks it for the state and journal of every candidate,
// and prints a line per file with who did what.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const WORK = process.env.SWEEP_WORK;
const CREW = process.env.SWEEP_CREW;
const POLYCREW = process.env.POLYCREW_ROOT;
const EXAMPLE = process.env.EXAMPLE_ROOT;
const targetsFile = process.argv[2];

const targets = readFileSync(targetsFile, 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean);

/** One polycrew session over stdio, the way a host drives it. */
function session() {
  const child = spawn(process.execPath, ['--no-warnings', join(POLYCREW, 'bin', 'polycrew.mjs')], {
    env: {
      ...process.env,
      POLYCREW_WORKFLOWS: join(EXAMPLE, 'workflows'),
      POLYCREW_INSTANCE: CREW,
      POLYCREW_DB: join(WORK, 'sweep.sqlite'),
      POLYCREW_HOME: join(WORK, 'registry'),
      POLYCREW_AGENT: 'summary',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Map();
  child.stderr.resume();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const mine = ++id;
    waiters.set(mine, res);
    setTimeout(() => rej(new Error(`timeout on ${method}`)), 60_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.result?.structuredContent ?? r.result;
  };
  return { rpc, call, kill: () => child.kill('SIGKILL') };
}

const PHASE = {
  done: '[32mchanged + verified[0m',
  skipped: '[90mno change needed[0m',
  failed: '[33mfailed[0m',
  editing: '[36mstill editing[0m',
  verifying: '[36mstill verifying[0m',
  idle: '[90mnot started[0m',
};

const s = session();
try {
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const rows = [];
  for (const target of targets) {
    const instance = `claude-code|${CREW}|codemod-target|${target}`;
    const state = await s.call('workflow_state', { instance });
    if (state?.error || !state?.state) {
      rows.push({ target, phase: 'not selected', who: '', note: 'the planner did not queue this file' });
      continue;
    }
    const { journal } = await s.call('workflow_journal', { instance });
    const actors = [...new Set(journal
      .filter((r) => r.via === 'report')
      .map((r) => r.actor))];
    rows.push({
      target,
      phase: state.state.phase,
      who: actors.join(', '),
      note: state.state.reason || '',
    });
  }

  const width = Math.min(60, Math.max(...rows.map((r) => r.target.length), 10));
  for (const r of rows) {
    const label = PHASE[r.phase] ?? `[90m${r.phase}[0m`;
    console.log(`    ${r.target.padEnd(width)}  ${label}${r.note ? `  (${r.note})` : ''}`);
    if (r.who) console.log(`    ${' '.repeat(width)}  by ${r.who}`);
  }

  const tally = rows.reduce((acc, r) => ({ ...acc, [r.phase]: (acc[r.phase] ?? 0) + 1 }), {});
  const workers = new Set(rows.flatMap((r) => r.who.split(', ').filter(Boolean)));
  console.log('');
  console.log(`    ${rows.length} candidate(s): `
    + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', '));
  console.log(`    ${workers.size} agent(s) did the work, and no file was edited twice —`);
  console.log('    that last part is the workflow\'s admitted rule, not a hope.');
} finally {
  s.kill();
}
