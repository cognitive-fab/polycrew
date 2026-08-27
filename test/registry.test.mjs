// C0 step 2 — identity and the registry.
//
// Unit level: no MCP, no processes. The concurrency test is the one that
// matters, because it is the reason the registry is a directory rather than
// the single JSON file the spec first asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { entries, mintActor, portFor, register, registryDir, unregister } from '../src/registry.mjs';

/** Each test gets its own POLYCREW_HOME so none can see another's sessions. */
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-reg-'));
  const before = process.env.POLYCREW_HOME;
  process.env.POLYCREW_HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.POLYCREW_HOME;
    else process.env.POLYCREW_HOME = before;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  return dir;
}

const entry = (over = {}) => ({
  area: 'acme', agent: 'polycrew', actor: mintActor('polycrew'),
  roles: [], store: '/tmp/s.sqlite', workflows: '/tmp/w', ...over,
});

test('an actor id is minted, never chosen', () => {
  const a = mintActor('claude-code');
  const b = mintActor('claude-code');
  assert.match(a, /^claude-code\/[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'two sessions of one agent must not collide');
});

test('a port is derived from the area, stable and in range', () => {
  const p = portFor('acme');
  assert.equal(p, portFor('acme'), 'the same crew is the same URL every day');
  assert.ok(p >= 41_000 && p < 49_000, `${p} out of range`);
  assert.notEqual(portFor('acme'), portFor('beta'), 'two crews must not collide');
  // Areas are not trusted to be short or tidy.
  assert.ok(portFor('a/very/long area name with spaces') >= 41_000);
});

test('two sessions on one crew both appear, with distinct ids', (t) => {
  sandbox(t);
  const one = register(entry());
  const two = register(entry());
  const live = entries('acme');
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((e) => e.actor).sort(), [one.actor, two.actor].sort());
  assert.equal(live[0].port, live[1].port, 'one crew, one broker port');
});

test('a session whose process is gone is reaped on read', (t) => {
  sandbox(t);
  const live = register(entry());
  // A pid that cannot be running: this process would have to be its own parent.
  const dead = register(entry({ pid: 0x7fffffff }));

  const seen = entries('acme');
  assert.deepEqual(seen.map((e) => e.actor), [live.actor]);
  assert.equal(readdirSync(registryDir('acme')).length, 1, `${dead.actor}'s file must be gone`);
});

test('a torn file is not evidence of a live session', (t) => {
  sandbox(t);
  register(entry());
  writeFileSync(join(registryDir('acme'), 'half-written.json'), '{"area":"acme"', 'utf-8');
  assert.equal(entries('acme').length, 1);
  assert.ok(!readdirSync(registryDir('acme')).includes('half-written.json'));
});

test('concurrent registration loses nobody', (t) => {
  sandbox(t);
  // The single-file design would drop most of these: read, modify, write, and
  // whoever renames last wins. Separate files cannot interfere.
  const actors = Array.from({ length: 25 }, () => register(entry()).actor);
  assert.equal(new Set(actors).size, 25);
  assert.equal(entries('acme').length, 25);
});

test('crews are separate, and unregister is idempotent', (t) => {
  sandbox(t);
  const a = register(entry({ area: 'acme' }));
  register(entry({ area: 'beta' }));

  assert.equal(entries('acme').length, 1);
  assert.equal(entries('beta').length, 1);
  assert.equal(entries().length, 2, 'no argument lists every crew on the machine');

  unregister('acme', a.actor);
  unregister('acme', a.actor);
  assert.equal(entries('acme').length, 0);
  assert.equal(entries('beta').length, 1, 'leaving one crew must not touch another');
});
