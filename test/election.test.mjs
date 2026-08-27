// C0 step 4 — election and proxy, with real processes.
//
// Binding the crew's port IS the election: the operating system picks exactly
// one winner, so there is no consensus protocol to get wrong. What CAN go wrong
// is timing, and that is what this file is for — three processes racing for one
// port, a call crossing a process boundary, and a broker dying mid-crew.
//
// Everything here is deliberately end-to-end. The election has no unit: a fake
// socket would only prove the fake agrees with itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ping } from '../src/link.mjs';
import { session, settle } from './session.mjs';

/** A crew of n sessions on one store, all started at once so they race. */
function crew(t, n, name) {
  const dir = mkdtempSync(join(tmpdir(), `polycrew-${name}-`));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: name,
  };
  const all = Array.from({ length: n }, () => session(env));
  t.after(() => {
    for (const s of all) s.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  return { all, env, dir };
}

const up = (s) => s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

test('three sessions race for one port and exactly one wins', async (t) => {
  const { all } = crew(t, 3, 'race');
  await Promise.all(all.map(up));

  const modes = all.map((s) => s.mode());
  assert.equal(modes.filter((m) => m === 'broker').length, 1, 'one broker, never two');
  assert.equal(modes.filter((m) => m === 'proxy').length, 2);

  const ports = new Set(all.map((s) => s.port()));
  assert.equal(ports.size, 1, 'the losers found the winner rather than picking their own port');
  assert.equal(await ping([...ports][0]), true, 'and something actually answers there');
});

test('a proxy call is served by the broker, and the broker owns the store', async (t) => {
  const { all } = crew(t, 2, 'forward');
  await Promise.all(all.map(up));

  const proxy = all.find((s) => s.mode() === 'proxy');
  const broker = all.find((s) => s.mode() === 'broker');
  assert.ok(proxy && broker);

  // The proxy never opened the library — only the broker certifies — yet it
  // lists the same catalogue, because the answer comes from the broker.
  const seen = await proxy.call('workflow_list', {});
  assert.ok(seen.workflows.some((w) => w.name === 'customer-brief'));
  assert.doesNotMatch(proxy.stderr(), /admitted:/, 'a proxy does not load the library');
  assert.match(broker.stderr(), /admitted: customer-brief/);

  // A run started through the proxy is one run, in the broker's store.
  const started = await proxy.call('workflow_start', {
    workflow: 'customer-brief', input: { date: '2026-01-02' },
  });
  assert.ok(started.instance, 'the run has an id the proxy never chose');
  const fromBroker = await broker.call('workflow_state', { instance: started.instance });
  assert.equal(fromBroker.instance, started.instance);
  assert.deepEqual(fromBroker.state, started.state, 'both sessions see one run, not two');

  // A report crosses the seam with nothing but an order id, so the broker has
  // to resolve that id back to its run — the one contract obligation a store
  // broker is most likely to miss, because open() drops the field on purpose.
  const after = await proxy.call('workflow_report', {
    order_id: started.next[0].order_id, result: { count: 3 },
  });
  assert.equal(after.instance, started.instance, 'the report reached the right run');
  assert.notDeepEqual(after.state, started.state, 'and moved it');
  assert.deepEqual(
    (await broker.call('workflow_state', { instance: started.instance })).state, after.state,
    'the session that did not report sees the same run');
});

test('two sessions starting the same run get the same run, across the proxy seam', async (t) => {
  const { all } = crew(t, 2, 'dedupe');
  await Promise.all(all.map(up));
  const [a, b] = all;

  // The derived key is what makes this true: neither session chose an id, so
  // neither can rename its way to a second run — the point of the whole thing.
  const [one, two] = await Promise.all([
    a.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-03-04' } }),
    b.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-03-04' } }),
  ]);
  assert.ok(one.instance, 'a run id, not an absent field quietly matching another absent one');
  assert.equal(one.instance, two.instance, 'one day, one brief');
});

test('a proxy takes over when the broker dies, and the work survives', async (t) => {
  const { all } = crew(t, 3, 'takeover');
  await Promise.all(all.map(up));

  const broker = all.find((s) => s.mode() === 'broker');
  const survivors = all.filter((s) => s !== broker);
  const port = broker.port();

  const started = await survivors[0].call('workflow_start', {
    workflow: 'customer-brief', input: { date: '2026-05-06' },
  });

  // No goodbye: SIGKILL leaves the port to the operating system and the store
  // to whoever opens it next. This is the crash case, not the shutdown case.
  broker.kill('SIGKILL');
  await settle(400);
  assert.equal(await ping(port), false, 'the broker is really gone');

  // The next call is what triggers the election — nobody polls, nobody watches.
  const after = await survivors[0].call('workflow_state', { instance: started.instance });
  assert.equal(after.instance, started.instance, 'the run outlived the process that started it');
  assert.deepEqual(after.next?.map((o) => o.tool), started.next?.map((o) => o.tool),
    'and so did its open work orders');

  const modes = survivors.map((s) => s.mode());
  assert.equal(modes.filter((m) => m === 'broker').length, 1, 'exactly one successor');
  assert.equal(await ping(port), true, 'on the same port, so nobody has to be told');

  // And the session that did NOT take over still reaches the new broker.
  const other = survivors.find((s) => s.mode() === 'proxy');
  const seen = await other.call('workflow_state', { instance: started.instance });
  assert.equal(seen.instance, started.instance);
});

test('a tool that throws is a failed call, not a dead broker', async (t) => {
  const { all } = crew(t, 2, 'errors');
  await Promise.all(all.map(up));
  const proxy = all.find((s) => s.mode() === 'proxy');

  await assert.rejects(
    () => proxy.call('workflow_start', { workflow: 'no-such-workflow' }),
    /no-such-workflow|unknown|not found/i,
  );
  // A missing required argument is named, not passed down to the store: the
  // proxy validates against the schema it forwarded from the broker.
  await assert.rejects(() => proxy.call('workflow_state', {}), /workflow_state needs 'instance'/);

  // The proxy must not have read either failure as an election and grabbed the port.
  assert.equal(proxy.mode(), 'proxy');
  assert.ok((await proxy.call('workflow_list', {})).workflows.length > 0, 'and it still works');
});
