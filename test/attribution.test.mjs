// C0 step 6 — the journal says who.
//
// polyrun records what happened. This records who asked, and the two are joined
// on read. The rule under every test here: an actor is recorded by the call
// that caused the step, never inferred afterwards from the newest journal row —
// which, with two sessions working one crew, names the wrong person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Attribution, systemActor } from '../src/attribution.mjs';
import { POLYFLOW, session } from './session.mjs';

const DATE = '2026-11-01';

// -- the store, on its own ---------------------------------------------------

const log = (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return new Attribution({ db });
};

test('the machine acting on its own is labelled, not named', () => {
  assert.deepEqual(systemActor('timer:abc'), { actor: 'system/timer', via: 'timer' });
  assert.deepEqual(systemActor('child:a|b|wf|k:complete'),
    { actor: 'system/child:a|b|wf|k', via: 'child' });
  assert.equal(systemActor('someorder:done'), null, 'a completion has a real actor to find');
  assert.equal(systemActor('$create'), null);
});

test('the first actor to cause a step keeps it', (t) => {
  const a = log(t);
  assert.equal(a.record('run', '$create', 'claude-code/aaaa', 'start'), true);
  assert.equal(a.record('run', '$create', 'claude-code/bbbb', 'start'), false,
    'a retry must not rewrite who did it');
  assert.deepEqual(a.forInstance('run').get('$create'), { actor: 'claude-code/aaaa', via: 'start' });
});

test('a row nobody claimed reads unattributed rather than wrong', (t) => {
  const a = log(t);
  a.record('run', 'o1:done', 'claude-code/aaaa', 'report');
  a.record('run', '#7', 'claude-code/bbbb', 'signal');

  const joined = a.join('run', [
    { seq: 2, action_id: 'o1:done' },
    { seq: 7, action_id: 'DENIED:9f2c-uuid' },
    { seq: 8, action_id: 'timer:t1' },
    { seq: 9, action_id: 'MYSTERY:uuid' },
  ]);
  assert.deepEqual(joined.map((r) => [r.actor, r.via]), [
    ['claude-code/aaaa', 'report'],
    ['claude-code/bbbb', 'signal'],
    ['system/timer', 'timer'],
    ['unattributed', 'unknown'],
  ]);
});

// -- through two real sessions ----------------------------------------------

async function pair(t, name, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), `polycrew-${name}-`));
  const env = {
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: name,
    ...extra,
  };
  const a = session(env);
  const b = session(env);
  t.after(() => {
    a.kill('SIGKILL'); b.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  await Promise.all([a, b].map((s) => s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })));
  return { a, b, dir };
}

/** Take the run's open order and report it, as one session. */
async function doOne(s, instance, result = { count: 2 }) {
  const { orders } = await s.call('workflow_next', { instance });
  assert.ok(orders.length, 'expected an open order');
  const got = await s.call('workflow_claim', { order_id: orders[0].order_id });
  assert.equal(got.claimed, true);
  return s.call('workflow_report', { order_id: orders[0].order_id, result });
}

test('the journal names the actor behind each step', async (t) => {
  const { a, b } = await pair(t, 'who');

  const started = await a.call('workflow_start', { workflow: 'customer-brief', input: { date: DATE } });
  const { instance } = started;

  // B does the first piece of work, A the second. Neither told the other.
  await doOne(b, instance);
  await doOne(a, instance);

  const { journal } = await a.call('workflow_journal', { instance });
  const byAction = new Map(journal.map((r) => [r.action, r]));

  assert.equal(byAction.get('$create').actor, a.actor(), 'the run belongs to whoever started it');
  assert.equal(byAction.get('$create').via, 'start');
  assert.equal(byAction.get('START').actor, a.actor());

  const first = journal.find((r) => r.action_id?.endsWith(':done'));
  assert.equal(first.actor, b.actor(), 'the step B caused is attributed to B');
  assert.equal(first.via, 'report');

  const completions = journal.filter((r) => r.action_id?.endsWith(':done'));
  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map((r) => r.actor), [b.actor(), a.actor()],
    'two sessions, two steps, and each named correctly');
  assert.notEqual(a.actor(), b.actor());
});

test('a signal is attributed to its caller, refused or not', async (t) => {
  const { a, b } = await pair(t, 'signal');
  const { instance } = await a.call('workflow_start', { workflow: 'customer-brief', input: { date: DATE } });

  // Not in the machine's action surface: a rejected step is still a journal
  // row, and knowing who tried it is the point of keeping one.
  const step = await b.call('workflow_signal', { instance, action: 'CANCEL', data: {} });
  assert.ok(Number.isInteger(step.step_seq));

  const { journal } = await a.call('workflow_journal', { instance });
  const row = journal.find((r) => r.seq === step.step_seq);
  assert.equal(row.action, 'CANCEL');
  assert.equal(row.actor, b.actor(), 'a refused attempt has an author too');
  assert.equal(row.via, 'signal');
});

test('a refused report records nobody', async (t) => {
  const { a, b } = await pair(t, 'refused');
  const { instance } = await a.call('workflow_start', { workflow: 'customer-brief', input: { date: DATE } });

  const { orders } = await b.call('workflow_next', { instance });
  await b.call('workflow_claim', { order_id: orders[0].order_id });

  // A is not the claimant. The report is refused, so it caused no step — and
  // must leave no trace saying it did.
  const refused = await a.call('workflow_report', { order_id: orders[0].order_id, result: {} });
  assert.equal(refused.error, 'not-your-order');

  const { journal } = await a.call('workflow_journal', { instance });
  assert.equal(journal.filter((r) => r.actor === a.actor() && r.via === 'report').length, 0,
    'a call that changed nothing must not appear to have');
});

test('a timer fires as system/timer, with nobody to blame', async (t) => {
  // The shipped workflow arms an eight-hour approval window. Copy it with a
  // short one: the point is the attribution, not the wait.
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-timer-wf-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });
  const to = join(dir, 'customer-brief');
  cpSync(join(POLYFLOW, 'workflows', 'customer-brief'), to, { recursive: true });
  const effects = join(to, 'effects.cjs');
  const patched = readFileSync(effects, 'utf-8').replace(/8 \* 60 \* 60 \* 1000/, '300');
  assert.notEqual(patched, readFileSync(effects, 'utf-8'), 'the approval window was not patched');
  writeFileSync(effects, patched, 'utf-8');

  const { a } = await pair(t, 'timer', { POLYCREW_WORKFLOWS: dir });
  const { instance } = await a.call('workflow_start', { workflow: 'customer-brief', input: { date: DATE } });

  await doOne(a, instance);                       // gathering -> drafting
  await doOne(a, instance);                       // drafting  -> review, timer armed

  // Nobody approves. The window closes on its own.
  let fired = null;
  for (let i = 0; i < 40 && !fired; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const { journal } = await a.call('workflow_journal', { instance });
    fired = journal.find((r) => r.action_id?.startsWith('timer:'));
  }
  assert.ok(fired, 'the approval window never closed');
  assert.equal(fired.action, 'DENIED');
  assert.equal(fired.actor, 'system/timer', 'no actor asked for this — the clock did');
  assert.equal(fired.via, 'timer');

  // And the steps a person did are still theirs.
  const { journal } = await a.call('workflow_journal', { instance });
  assert.ok(journal.some((r) => r.actor === a.actor()));
});
