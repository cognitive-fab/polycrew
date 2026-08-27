// C0 step 5 — two sessions, one crew, and no work done twice.
//
// This is the whole point of polycrew, so it is tested against real processes
// rather than against the store: two sessions share a project, both see the
// same runs, and the only thing stopping them from doing the same work twice is
// the claim. Neither ever supplies an actor — the server minted one for each at
// boot, and no schema has a field for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { session } from './session.mjs';

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];

/** Two sessions on one crew, both up. */
async function pair(t, name, envA = {}, envB = {}) {
  const dir = mkdtempSync(join(tmpdir(), `polycrew-${name}-`));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: name,
  };
  const a = session({ ...env, ...envA });
  const b = session({ ...env, ...envB });
  t.after(() => {
    a.kill('SIGKILL'); b.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  await Promise.all([a, b].map((s) => s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })));
  await Promise.all([a, b].map((s) => s.ready()));
  return { a, b };
}

/** Start one run per date, so the crew has several open orders at once. */
const fill = (s, dates = DATES) => Promise.all(dates.map(
  (date) => s.call('workflow_start', { workflow: 'customer-brief', input: { date } }),
));

test('workflow_next spans the crew, and names the run each order belongs to', async (t) => {
  const { a, b } = await pair(t, 'next');
  await fill(a);

  // Started by A, offered to B: work belongs to the crew, not to whoever began it.
  const { orders } = await b.call('workflow_next', {});
  assert.equal(orders.length, 3);
  assert.deepEqual(orders.map((o) => o.key).sort(), [...DATES].sort());
  for (const o of orders) {
    assert.equal(o.workflow, 'customer-brief');
    assert.ok(o.instance.endsWith(o.key), 'an order carries its run, since next spans runs');
    assert.equal(o.claimed_by, undefined, 'nothing here is claimed yet');
  }

  const one = await a.call('workflow_next', { instance: orders[0].instance });
  assert.deepEqual(one.orders.map((o) => o.order_id), [orders[0].order_id], 'scoped to one run');
});

test('a claimed order leaves everyone else’s next', async (t) => {
  const { a, b } = await pair(t, 'hide');
  await fill(a, DATES.slice(0, 2));

  const { orders } = await a.call('workflow_next', {});
  const got = await a.call('workflow_claim', { order_id: orders[0].order_id });
  assert.equal(got.claimed, true);
  assert.ok(got.claimed_until > 0, 'a claim is a lease, not a flag');

  const left = await b.call('workflow_next', {});
  assert.deepEqual(left.orders.map((o) => o.order_id), [orders[1].order_id]);

  // But it is still visible in the run, with its holder shown.
  const run = await b.call('workflow_state', { instance: orders[0].instance });
  assert.equal(run.next[0].claimed_by, a.actor(), 'workflow_state shows work that is not yours');
});

test('a contested claim is an answer, not an error', async (t) => {
  const { a, b } = await pair(t, 'contest');
  await fill(a, DATES.slice(0, 1));

  const { orders } = await a.call('workflow_next', {});
  await a.call('workflow_claim', { order_id: orders[0].order_id });

  // B asks for the same order. A model that got an error here would retry it;
  // this tells it to go and find other work instead.
  const refused = await b.call('workflow_claim', { order_id: orders[0].order_id });
  assert.equal(refused.claimed, false);
  assert.equal(refused.reason, 'claimed-by-other');
  assert.equal(refused.holder, a.actor());
  assert.match(refused.hint, /workflow_next/);

  // And re-claiming your own renews rather than refusing.
  const again = await a.call('workflow_claim', { order_id: orders[0].order_id });
  assert.equal(again.claimed, true);
});

test('only the claimant may report, and the refusal names the holder', async (t) => {
  const { a, b } = await pair(t, 'report');
  await fill(a, DATES.slice(0, 1));

  const { orders } = await b.call('workflow_next', {});
  await b.call('workflow_claim', { order_id: orders[0].order_id });

  const stolen = await a.call('workflow_report', { order_id: orders[0].order_id, result: { count: 1 } });
  assert.equal(stolen.error, 'not-your-order');
  assert.equal(
    (await a.call('workflow_state', { instance: orders[0].instance })).state.briefState, 'gathering',
    'a refused report must not move the run',
  );

  const mine = await b.call('workflow_report', { order_id: orders[0].order_id, result: { count: 1 } });
  assert.equal(mine.state.briefState, 'drafting');
});

test('two sessions drain one crew and every order is done exactly once', async (t) => {
  const { a, b } = await pair(t, 'drain');
  await fill(a);

  // Both sessions do the same thing: ask what is free, take one, do it.
  // Nobody assigns work and nobody tells the other what it took.
  const done = [];
  const turn = async (s) => {
    const { orders } = await s.call('workflow_next', {});
    if (!orders.length) return false;
    // Do what the refusal tells the model to do: take something else. A
    // session that gives up for the round instead can starve, because the
    // elected broker serves itself with no loopback hop and wins every race
    // for the first offer — a real asymmetry, not a test artefact.
    for (const o of orders) {
      const got = await s.call('workflow_claim', { order_id: o.order_id });
      if (!got.claimed) continue;
      await s.call('workflow_report', { order_id: got.order.order_id, result: { count: 1 } });
      done.push([got.order.order_id, s.actor()]);
      return true;
    }
    return true;                                       // everything free was taken; look again
  };

  // CONCURRENTLY, not in turns. Alternating would pass whether or not the
  // claim did anything; the case worth testing is both sessions reaching for
  // the same order at the same moment, which is the ordinary case when two
  // people leave two `claude` sessions running in one project.
  for (let i = 0; i < 12; i += 1) {
    const [moreA, moreB] = await Promise.all([turn(a), turn(b)]);
    if (!moreA && !moreB) break;
  }

  const ids = done.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length, 'no order was completed twice');
  assert.ok(ids.length >= 3, `expected at least one order per run, got ${ids.length}`);
  assert.equal(new Set(done.map(([, who]) => who)).size, 2, 'both sessions actually did work');

  // Every run moved past its first step.
  for (const date of DATES) {
    const r = await a.call('workflow_state', { instance: `polycrew|drain|customer-brief|${date}` });
    assert.notEqual(r.state.briefState, 'gathering', `run ${date} never advanced`);
  }
});

test('the role filter hides nothing from a session with no roles', async (t) => {
  // Roles come from the environment at boot, never from a tool, so this is set
  // where a project's .mcp.json would set it.
  const { a, b } = await pair(t, 'roles', { POLYCREW_ROLES: 'reviewer' }, {});
  await fill(a, DATES.slice(0, 1));

  // customer-brief addresses no effect to a role, so both see the work: the
  // filter must narrow role-ADDRESSED orders, not everything.
  assert.equal((await a.call('workflow_next', {})).orders.length, 1);
  assert.equal((await b.call('workflow_next', {})).orders.length, 1);
  assert.match(a.stderr(), /roles: reviewer/);
});

test('two sessions claiming the same order at the same instant: exactly one wins', async (t) => {
  const { a, b } = await pair(t, 'race');
  await fill(a, DATES.slice(0, 1));

  const { orders } = await a.call('workflow_next', {});
  const id = orders[0].order_id;

  // Not "one then the other" — both in flight at once, which is the ordinary
  // case when two sessions poll a crew on their own schedules.
  const [x, y] = await Promise.all([
    a.call('workflow_claim', { order_id: id }),
    b.call('workflow_claim', { order_id: id }),
  ]);
  const won = [x, y].filter((r) => r.claimed);
  assert.equal(won.length, 1, 'a claim is exclusive or it is nothing');

  const lost = [x, y].find((r) => !r.claimed);
  assert.equal(lost.reason, 'claimed-by-other');
  assert.equal(lost.holder, won[0].order.claimed_by, 'the loser is told who actually has it');

  // And only the winner can move the run.
  const loser = won[0] === x ? b : a;
  const winner = won[0] === x ? a : b;
  assert.equal((await loser.call('workflow_report', { order_id: id, result: {} })).error, 'not-your-order');
  assert.equal((await winner.call('workflow_report', { order_id: id, result: { count: 1 } })).state.briefState, 'drafting');
});
