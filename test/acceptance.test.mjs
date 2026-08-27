// C0 step 8 — acceptance, on a workflow that actually fans out.
//
// Everything before this used customer-brief, which is sequential: one order
// open at a time, so two sessions could only ever contend for the same one.
// release-check emits THREE orders in a single step. That is the shape a crew
// is for, and it is the shape where "each order is done exactly once" stops
// being obvious.
//
// This is the scripted half of step 8 — the regression that runs on every
// commit, with no model and no cost. The other half is two real `claude`
// sessions driving the same workflow through the same tools; that run is
// recorded in FINDINGS-step8.md rather than here, because it needs an API key
// and takes minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';

import { ROOT, session, settle } from './session.mjs';

const WORKFLOWS = resolve(ROOT, 'test', 'fixtures', 'workflows');
const VERSION = '2.4.0';

/** A crew of n sessions on one release, with a short claim lease. */
async function crew(t, name, n = 2, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), `polycrew-${name}-`));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: name,
    POLYCREW_WORKFLOWS: WORKFLOWS,
    POLYCREW_LEASE_MS: '1500',
    ...extra,
  };
  const all = Array.from({ length: n }, () => session(env));
  t.after(() => {
    for (const s of all) s.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  await Promise.all(all.map((s) => s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })));
  await Promise.all(all.map((s) => s.ready()));
  return all;
}

const getJson = (port, path) => new Promise((res, rej) => {
  const req = request({ host: '127.0.0.1', port, path, timeout: 10_000 }, (r) => {
    let body = '';
    r.on('data', (c) => { body += c; });
    r.on('end', () => res(JSON.parse(body)));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', rej);
  req.end();
});

test('three checks are offered at once, to whoever asks', async (t) => {
  const [a, b] = await crew(t, 'fanout');

  const started = await a.call('workflow_start', { workflow: 'release-check', input: { version: VERSION } });
  assert.equal(started.state.phase, 'checking');
  assert.equal(started.next.length, 3, 'the fan-out is the point');

  // Started by A, and all three are equally available to B.
  const { orders } = await b.call('workflow_next', {});
  assert.deepEqual(orders.map((o) => o.tool).sort(), ['Bash', 'Bash', 'Bash']);
  assert.deepEqual([...new Set(orders.map((o) => o.instance))], [started.instance]);
  assert.equal(orders.length, 3);
  for (const o of orders) assert.equal(o.claimed_by, undefined);
});

test('two sessions share the fan-out and nothing ships until all three report', async (t) => {
  const [a, b] = await crew(t, 'share');
  const started = await a.call('workflow_start', { workflow: 'release-check', input: { version: VERSION } });
  const { instance } = started;

  const done = [];
  const turn = async (s) => {
    const { orders } = await s.call('workflow_next', { instance });
    for (const o of orders) {
      const got = await s.call('workflow_claim', { order_id: o.order_id });
      if (!got.claimed) continue;
      const v = await s.call('workflow_report', { order_id: o.order_id, result: {} });
      done.push({ order: o.order_id, who: s.actor(), phase: v.state?.phase });
      return true;
    }
    return orders.length > 0;
  };

  // Both reach for the same list at the same moment, which is what two people
  // leaving two sessions running in one project actually produces.
  for (let i = 0; i < 8; i += 1) {
    const [x, y] = await Promise.all([turn(a), turn(b)]);
    if (!x && !y) break;
  }

  const ids = done.map((d) => d.order);
  assert.equal(new Set(ids).size, ids.length, 'no check was run twice');
  assert.equal(ids.length, 4, 'three checks and the publish that follows them');
  assert.equal(new Set(done.map((d) => d.who)).size, 2, 'both sessions did work');

  // The run left 'checking' only once, and only after the third report.
  const phases = done.map((d) => d.phase);
  assert.deepEqual(phases.slice(0, 2), ['checking', 'checking'],
    'the first two reports must not move the run out of checking');

  const final = await a.call('workflow_state', { instance });
  assert.equal(final.state.phase, 'shipped');
  assert.equal(final.state.checksDone, 3);
  assert.equal(final.state.failures, 0);
  assert.equal(final.done, true);
});

test('a failed check blocks the release, and the other checks still report', async (t) => {
  const [a] = await crew(t, 'blocked', 1);
  const started = await a.call('workflow_start', { workflow: 'release-check', input: { version: VERSION } });
  const { instance } = started;

  // One check finds a problem. `permanent` says this is a RESULT, not an
  // infrastructure fault, so it is not retried.
  const first = started.next[0];
  await a.call('workflow_claim', { order_id: first.order_id });
  await a.call('workflow_report', {
    order_id: first.order_id, ok: false, permanent: true, error: 'found-a-problem',
  });

  let v = await a.call('workflow_state', { instance });
  assert.equal(v.state.phase, 'checking', 'a failure does not abandon the checks still running');
  assert.equal(v.next.length, 2, 'and their orders are still open');

  for (const o of v.next) {
    await a.call('workflow_claim', { order_id: o.order_id });
    await a.call('workflow_report', { order_id: o.order_id, result: {} });
  }

  v = await a.call('workflow_state', { instance });
  assert.equal(v.state.phase, 'blocked');
  assert.equal(v.state.failures, 1);
  assert.equal(v.state.checksDone, 3);
  assert.equal(v.next.length, 0, 'nothing is published');
  assert.equal(v.done, true);
});

test('a session that dies mid-order loses it, and another finishes the work', async (t) => {
  const sessions = await crew(t, 'takeover');
  // By role, not by position: whichever session binds the port first is the
  // broker, and under load that is not reliably the one spawned first.
  const broker = sessions.find((s) => s.mode() === 'broker');
  const worker = sessions.find((s) => s.mode() === 'proxy');
  assert.ok(broker && worker, `expected one of each, got ${sessions.map((s) => s.mode())}`);

  const started = await broker.call('workflow_start', { workflow: 'release-check', input: { version: VERSION } });
  const { instance } = started;

  // The proxy takes a check and then dies without reporting or saying goodbye.
  const { orders } = await worker.call('workflow_next', { instance });
  const abandoned = orders[0].order_id;
  const got = await worker.call('workflow_claim', { order_id: abandoned });
  assert.equal(got.claimed, true);
  assert.equal(got.order.claimed_by, worker.actor());

  worker.kill('SIGKILL');
  await settle(300);

  // While the lease runs, the work is still the dead session's. Nobody else
  // may take it and nobody else may report it: a session that is merely slow
  // must not have its work stolen.
  const held = await broker.call('workflow_next', { instance });
  assert.equal(held.orders.length, 2, 'the claimed order is not on offer yet');
  const early = await broker.call('workflow_claim', { order_id: abandoned });
  assert.equal(early.claimed, false);
  assert.equal(early.holder, worker.actor());

  // The dashboard names the holder, and shows the lease running out.
  const before = await getJson(broker.port(), '/dashboard.json');
  const row = before.runs[0].orders.find((o) => o.orderId === abandoned);
  assert.equal(row.claimedBy, worker.actor());

  // Silence past the lease is what releases it. Nothing was reassigned by a
  // supervisor, because there is no supervisor.
  await settle(1800);
  const freed = await broker.call('workflow_next', { instance });
  assert.deepEqual(freed.orders.map((o) => o.order_id).sort().includes(abandoned), true,
    'the abandoned order comes back on offer');

  const taken = await broker.call('workflow_claim', { order_id: abandoned });
  assert.equal(taken.claimed, true, 'and the survivor can take it');
  assert.equal(taken.order.claimed_by, broker.actor());

  // Finish the release with the session that is left.
  for (let i = 0; i < 6; i += 1) {
    const v = await broker.call('workflow_state', { instance });
    if (v.done) break;
    for (const o of v.next) {
      await broker.call('workflow_claim', { order_id: o.order_id });
      await broker.call('workflow_report', { order_id: o.order_id, result: {} });
    }
  }

  const end = await broker.call('workflow_state', { instance });
  assert.equal(end.state.phase, 'shipped', 'the work outlived the session that started it');

  // The journal names who did what, including the check the dead session never
  // finished — its completion belongs to whoever actually reported it.
  const { journal } = await broker.call('workflow_journal', { instance });
  const completions = journal.filter((r) => r.action_id?.endsWith(':done'));
  assert.equal(completions.length, 4);
  assert.equal(new Set(completions.map((r) => r.actor)).has(worker.actor()), false,
    'a session that claimed but never reported did nothing, and the journal says so');
  assert.equal(journal.find((r) => r.action === '$create').actor, broker.actor());

  // And the page agrees the run is over.
  const after = await getJson(broker.port(), '/dashboard.json');
  assert.equal(after.runs.length, 0, 'a finished run is no longer in flight');
});

test('work reported into a dead broker is not lost, and not done twice', async (t) => {
  // The failure this replaces: an agent changes a file, runs the tests, and
  // reports — into a broker that exited when the session before it did. The
  // order row is right there and claimable, but the promise the engine was
  // waiting on went with the process. Refusing that report throws away work
  // that was really done, and the order is later handed to somebody who does
  // it again.
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-durable-'));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: 'durable',
    POLYCREW_WORKFLOWS: WORKFLOWS,
    POLYCREW_LEASE_MS: '60000',
    POLYCREW_EFFECT_LEASE_MS: '1500',   // so a re-offer is watchable
  };
  const open = () => session(env);

  const first = open();
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });
  t.after(() => first.kill('SIGKILL'));
  await first.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await first.ready();

  const started = await first.call('workflow_start', {
    workflow: 'release-check', input: { version: VERSION },
  });
  const order = started.next[0].order_id;

  // The broker goes away with the order still open. Everything it was holding
  // in memory goes with it.
  first.kill('SIGKILL');
  await settle(400);

  const second = open();
  t.after(() => second.kill('SIGKILL'));
  await second.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await second.ready();
  assert.equal(second.mode(), 'broker', 'the survivor opened the store');

  // It can see and claim the order, because that part lives in SQLite.
  const got = await second.call('workflow_claim', { order_id: order });
  assert.equal(got.claimed, true);

  // …and the report is RECORDED rather than refused.
  const ack = await second.call('workflow_report', { order_id: order, result: {} });
  assert.equal(ack.error, undefined, 'work that was done must not come back as an error');
  assert.match(ack.note ?? '', /Do not do this work again/);

  // Until it is delivered, nobody else is offered it — this is the whole
  // point: a recorded result must not look like work still to do.
  assert.equal((await second.call('workflow_next', {})).orders
    .some((o) => o.order_id === order), false);

  // The engine re-offers the effect once its lease lapses, the stored result
  // settles it there and then, and the run moves without anyone repeating it.
  let state = null;
  for (let i = 0; i < 40; i += 1) {
    await settle(200);
    state = await second.call('workflow_state', { instance: started.instance });
    if (state.state.checksDone > 0) break;
  }
  assert.equal(state.state.checksDone, 1, 'the recorded result reached the run');

  const { journal } = await second.call('workflow_journal', { instance: started.instance });
  const completions = journal.filter((r) => r.action_id === `${order}:done`);
  assert.equal(completions.length, 1, 'delivered once, not once per re-offer');
});
