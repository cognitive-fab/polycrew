// C0 step 1 — the dependency direction holds.
//
// polycrew serves polyflow's tools through polyflow's own MCP server, using it
// as a package. Nothing is forked, nothing is reimplemented, and if the
// boundary ever narrows this fails before anything is built on top of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { entries } from '../src/registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLYFLOW = resolve(dirname(createRequire(import.meta.url).resolve('polyflow')), '..');

/** Drive a polycrew process over stdio JSON-RPC, the way a host does. */
function session(env = {}) {
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'bin', 'polycrew.mjs')], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Map();
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
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
    setTimeout(() => rej(new Error(`timeout on ${method}\n${stderr}`)), 60_000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
  });

  return { rpc, kill: (sig) => child.kill(sig), stderr: () => stderr, pid: child.pid };
}

test('polycrew serves polyflow, as a dependency', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-'));
  const s = session({
    POLYCREW_DB: join(dir, 'c0.sqlite'),
    POLYCREW_AGENT: 'polycrew',
    POLYCREW_INSTANCE: 'scaffold',
  });
  t.after(() => {
    s.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'polycrew');

  const listed = await s.rpc('tools/list', {});
  assert.deepEqual(listed.result.tools.map((x) => x.name).sort(), [
    'workflow_journal', 'workflow_list', 'workflow_report',
    'workflow_signal', 'workflow_start', 'workflow_state',
  ], 'the six polyflow tools, unchanged');

  // The admission gate ran inside polycrew's process, on the library polyflow ships.
  const catalog = await s.rpc('tools/call', { name: 'workflow_list', arguments: {} });
  const wf = catalog.result.structuredContent.workflows.find((w) => w.name === 'customer-brief');
  assert.equal(wf.admitted, true);
  assert.ok(wf.guarantees.includes('no-post-without-prior-approval'));
  assert.match(s.stderr(), /\[polycrew\] admitted: customer-brief/);

  // And a run works end to end through it.
  const started = await s.rpc('tools/call', {
    name: 'workflow_start',
    arguments: { workflow: 'customer-brief', input: { date: '2026-08-26' } },
  });
  const order = started.result.structuredContent.next[0];
  assert.equal(order.tool, 'github_search_issues');

  const reported = await s.rpc('tools/call', {
    name: 'workflow_report', arguments: { order_id: order.order_id, result: { count: 3 } },
  });
  assert.equal(reported.result.structuredContent.state.briefState, 'drafting');
});

test('the workflow library defaults to the one polyflow ships', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-lib-'));
  const s = session({ POLYCREW_DB: join(dir, 'lib.sqlite'), POLYCREW_INSTANCE: 'lib' });
  t.after(() => {
    s.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const catalog = await s.rpc('tools/call', { name: 'workflow_list', arguments: {} });
  assert.ok(
    catalog.result.structuredContent.workflows.some((w) => w.name === 'customer-brief'),
    `expected the bundled library at ${join(POLYFLOW, 'workflows')}`
  );
});

test('roles are read from the environment, never from a tool', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-roles-'));
  const s = session({
    POLYCREW_DB: join(dir, 'roles.sqlite'), POLYCREW_INSTANCE: 'roles',
    POLYCREW_ROLES: 'gatherer, reviewer',
  });
  t.after(() => {
    s.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const listed = await s.rpc('tools/list', {});
  for (const tool of listed.result.tools) {
    const props = Object.keys(tool.inputSchema.properties ?? {});
    assert.ok(!props.includes('roles'), `${tool.name} must not take roles`);
    assert.ok(!props.includes('actor'), `${tool.name} must not take an actor`);
  }
  assert.match(s.stderr(), /\[polycrew\] roles: gatherer, reviewer/);
});

test('two sessions on one crew register separately, and a dead one is reaped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-crew-'));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: 'crew-test',
  };
  const before = process.env.POLYCREW_HOME;
  process.env.POLYCREW_HOME = env.POLYCREW_HOME;

  const a = session(env);
  const b = session(env);
  t.after(() => {
    a.kill(); b.kill();
    if (before === undefined) delete process.env.POLYCREW_HOME;
    else process.env.POLYCREW_HOME = before;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  // Both are up once they answer; registration happens before serve().
  await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const both = entries('crew-test');
  assert.equal(both.length, 2, 'each session owns one registry entry');
  assert.equal(new Set(both.map((e) => e.actor)).size, 2, 'ids neither session chose, and distinct');
  assert.deepEqual([...new Set(both.map((e) => e.port))].length, 1, 'one crew, one broker port');
  assert.deepEqual(both.map((e) => e.pid).sort(), [a.pid, b.pid].sort());
  assert.match(a.stderr(), /\[polycrew\] actor polycrew\/[0-9a-f]{8} · crew crew-test · port \d+/);

  // Kill one without letting it clean up: the survivor's next read reaps it.
  a.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const left = entries('crew-test');
  assert.equal(left.length, 1, 'a session whose process is gone leaves nothing behind');
  assert.equal(left[0].pid, b.pid);
});
