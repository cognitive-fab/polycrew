// C0 step 3 — where the semantics get decided.
//
// No MCP, no HTTP, no processes: a fake clock and the table. This is the step
// worth over-testing, because a claim race found here is a failing assertion
// and a claim race found in step 8 is a flaky acceptance run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StoreBroker } from '../src/store-broker.mjs';

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

/** Let queued promise callbacks run, so `settled` reflects reality. */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * Invoke a broker handler the way polyrun's worker does, and keep the promise
 * so a test can see how it settled without awaiting a rejection it expects.
 */
function issue(broker, { kind = 'deploy', instanceId = 'crew|acme|wf|k', intentId = kind + '-1', spec = {}, attempt = 1, payload = {} } = {}) {
  const settled = { state: 'pending', value: undefined };
  const ctx = { instanceId, seq: 1, attempt, extendLease: async () => {} };
  broker.handler(kind, spec)(payload, intentId, ctx).then(
    (v) => { settled.state = 'resolved'; settled.value = v; },
    (e) => { settled.state = 'rejected'; settled.value = e; },
  );
  return { intentId, settled };
}

const broker = (t, opts = {}) => {
  const c = clock();
  const b = new StoreBroker({ now: c.now, leaseMs: 60_000, heartbeatMs: 10_000, ...opts });
  t.after(() => b.close());
  return { b, c };
};

test('an issued order is open, unclaimed, and visible to the run', (t) => {
  const { b } = broker(t);
  issue(b, { spec: { tool: 'Bash', why: 'deploy it', role: 'operator' } });

  const [o] = b.open('crew|acme|wf|k');
  assert.equal(o.tool, 'Bash');
  assert.equal(o.role, 'operator');
  assert.equal(o.status, 'open');
  assert.equal(o.claimedBy, null);
  assert.equal(b.issued('crew|acme|wf|k').length, 1);
  assert.equal(b.orderById('deploy-1').why, 'deploy it');
});

test('a claim holds, and a second claimant is told who has it', (t) => {
  const { b } = broker(t);
  issue(b);

  const first = b.claim('deploy-1', 'claude-code/aaaa');
  assert.equal(first.ok, true);
  assert.equal(first.order.claimedBy, 'claude-code/aaaa');

  const second = b.claim('deploy-1', 'claude-code/bbbb');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'claimed-by-other');
  assert.equal(second.holder, 'claude-code/aaaa');
  assert.match(second.hint, /workflow_next/);

  // Re-claiming your own renews rather than refusing.
  assert.equal(b.claim('deploy-1', 'claude-code/aaaa').ok, true);
});

test('a claimed order is not offered to anyone else', (t) => {
  const { b } = broker(t);
  issue(b, { intentId: 'a' });
  issue(b, { intentId: 'b' });

  assert.equal(b.offers().length, 2);
  b.claim('a', 'claude-code/aaaa');
  assert.deepEqual(b.offers().map((o) => o.orderId), ['b']);
});

test('a lease nobody renews expires, and the order is offered again', (t) => {
  const { b, c } = broker(t);
  issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');
  assert.equal(b.offers().length, 0);

  c.tick(59_000);
  assert.equal(b.offers().length, 0, 'still held while the lease runs');

  c.tick(2_000);
  const free = b.offers();
  assert.equal(free.length, 1, 'silence past the lease releases it');
  assert.equal(free[0].claimedBy, null);
  assert.equal(free[0].status, 'open', 'the order survives; only the holder is dropped');

  // And someone else can take it.
  assert.equal(b.claim('deploy-1', 'claude-code/bbbb').ok, true);
});

test('renewing keeps an order while the work is still going', (t) => {
  const { b, c } = broker(t);
  issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');

  c.tick(50_000);
  assert.equal(b.renew('deploy-1', 'claude-code/aaaa').ok, true);
  c.tick(50_000);
  assert.equal(b.offers().length, 0, 'renewed before it lapsed');

  const notMine = b.renew('deploy-1', 'claude-code/bbbb');
  assert.equal(notMine.ok, false);
  assert.equal(notMine.reason, 'not-your-order');
});

test('only the claimant may report', (t) => {
  const { b } = broker(t);
  const { settled } = issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');

  const stranger = b.report('deploy-1', { result: { ok: true }, actor: 'claude-code/bbbb' });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, 'not-your-order');
  assert.equal(stranger.holder, 'claude-code/aaaa');
  assert.equal(settled.state, 'pending', 'a refused report must not settle the order');

  assert.equal(b.report('deploy-1', { result: { count: 3 }, actor: 'claude-code/aaaa' }).ok, true);
});

test('an unclaimed order can be reported by anyone — the single-agent path', async (t) => {
  const { b } = broker(t);
  const { settled } = issue(b);
  assert.equal(b.report('deploy-1', { result: { count: 3 } }).ok, true);
  await flush();
  assert.equal(settled.state, 'resolved');
  assert.deepEqual(settled.value, { count: 3 });
});

test('a report after losing the lease to someone else is refused', async (t) => {
  const { b, c } = broker(t);
  const { settled } = issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');
  c.tick(61_000);
  b.claim('deploy-1', 'claude-code/bbbb');

  const late = b.report('deploy-1', { result: {}, actor: 'claude-code/aaaa' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'not-your-order');
  assert.equal(settled.state, 'pending');

  assert.equal(b.report('deploy-1', { result: {}, actor: 'claude-code/bbbb' }).ok, true);
  await flush();
  assert.equal(settled.state, 'resolved');
});

test('a settled order cannot be settled twice', (t) => {
  const { b } = broker(t);
  issue(b);
  assert.equal(b.report('deploy-1', { result: {} }).ok, true);

  const again = b.report('deploy-1', { result: {} });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'order-expired');
  assert.equal(b.open('crew|acme|wf|k').length, 0);
  assert.equal(b.claim('deploy-1', 'claude-code/aaaa').reason, 'order-expired');
});

test('a failure is a result: permanent travels to the waiting handler', async (t) => {
  const { b } = broker(t);
  const { settled } = issue(b);
  b.report('deploy-1', { ok: false, permanent: true, error: 'operator declined' });

  await flush();
  assert.equal(settled.state, 'rejected');
  assert.equal(settled.value.permanent, true);
  assert.match(settled.value.message, /operator declined/);
});

test('an order for a role this actor does not hold is neither offered nor claimable', (t) => {
  const { b } = broker(t);
  issue(b, { intentId: 'human-1', spec: { role: 'reviewer' } });
  issue(b, { intentId: 'any-1' });

  assert.deepEqual(b.offers({ roles: ['gatherer'] }).map((o) => o.orderId), ['any-1'],
    'a role-less order stays open to anyone');
  assert.deepEqual(b.offers({ roles: ['reviewer'] }).map((o) => o.orderId).sort(), ['any-1', 'human-1']);

  const refused = b.claim('human-1', 'claude-code/aaaa', { roles: ['gatherer'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-your-role');
});

test('offers can be scoped to one run', (t) => {
  const { b } = broker(t);
  issue(b, { intentId: 'a', instanceId: 'crew|acme|wf|one' });
  issue(b, { intentId: 'b', instanceId: 'crew|acme|wf|two' });

  assert.equal(b.offers().length, 2);
  assert.deepEqual(b.offers({ instanceId: 'crew|acme|wf|two' }).map((o) => o.orderId), ['b']);
});

test('a re-offered effect reappears as the same order, unclaimed, at a higher attempt', (t) => {
  const { b } = broker(t);
  issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');

  // polyrun re-runs the handler after a worker crash: same intent id, attempt+1.
  issue(b, { attempt: 2 });

  const [o] = b.open('crew|acme|wf|k');
  assert.equal(b.issued('crew|acme|wf|k').length, 1, 'one order, not two');
  assert.equal(o.attempt, 2);
  assert.equal(o.claimedBy, null, 'a re-offer belongs to nobody');
});

test('orders survive the broker: rows stay open when a process gives up', async (t) => {
  const { b } = broker(t);
  const { settled } = issue(b);
  b.claim('deploy-1', 'claude-code/aaaa');

  b.abort('broker died');
  await flush();
  assert.equal(settled.state, 'rejected');
  assert.equal(b.open('crew|acme|wf|k').length, 1, 'the work is not lost with the process');

  // But nothing is parked any more, so a report has nowhere to go.
  const orphan = b.report('deploy-1', { result: {}, actor: 'claude-code/aaaa' });
  assert.equal(orphan.ok, false);
  assert.equal(orphan.reason, 'order-expired');
  assert.match(orphan.hint, /workflow_next/);
});
