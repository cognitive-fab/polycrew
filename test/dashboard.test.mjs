// C0 step 7 — the page a person reads.
//
// Read-only and loopback-only, on the port the broker already holds. The
// property worth testing is not that it renders: it is that the page and the
// JSON say the same thing as the tools, that it cannot be written to, and that
// it cannot be reached from anywhere but this machine — because nothing in
// polycrew is authenticated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

import { ago, dashboardRoutes, page, snapshot } from '../src/dashboard.mjs';
import { acquire, isLoopback } from '../src/link.mjs';
import { session } from './session.mjs';

// -- the parts, on their own -------------------------------------------------

test('durations read as a person would say them', () => {
  assert.equal(ago(400), 'just now');
  assert.equal(ago(45_000), '45s');
  assert.equal(ago(4 * 60_000), '4m');
  assert.equal(ago(130 * 60_000), '2h 10m');
  assert.equal(ago(50 * 3_600_000), '2d 2h');
});

test('loopback is loopback however it is spelled', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) {
    assert.equal(isLoopback(a), true, a);
  }
  for (const a of ['10.0.0.5', '192.168.1.7', '0.0.0.0', '::', 'example.com', '']) {
    assert.equal(isLoopback(a), false, a);
  }
});

test('binding anything but loopback is refused, not configured', async () => {
  await assert.rejects(() => acquire([45_123], { host: '0.0.0.0' }), /binds loopback only/);
  await assert.rejects(() => acquire([45_123], { host: '10.0.0.5' }), /nothing here is authenticated/);
});

/** A request/response pair the routes can be driven with, with no socket. */
function fakeCall(url, { method = 'GET', from = '127.0.0.1' } = {}) {
  const res = { code: null, headers: null, body: '', ended: false };
  return [
    { url, method, socket: { remoteAddress: from } },
    {
      writeHead(code, headers) { res.code = code; res.headers = headers; },
      end(body) { res.body = body ?? ''; res.ended = true; },
    },
    res,
  ];
}

test('the dashboard is unreachable from off this machine', async () => {
  const routes = dashboardRoutes(async () => { throw new Error('must not be asked'); });
  const [req, res, out] = fakeCall('/dashboard', { from: '10.0.0.5' });

  assert.equal(routes(req, res), true, 'the route is handled, and refused');
  assert.equal(out.code, 403);
  assert.match(out.body, /loopback-only/);
});

test('the dashboard cannot be written to', async () => {
  const routes = dashboardRoutes(async () => { throw new Error('must not be asked'); });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const [req, res, out] = fakeCall('/dashboard', { method });
    assert.equal(routes(req, res), true);
    assert.equal(out.code, 405, method);
    assert.equal(out.headers.allow, 'GET, HEAD');
  }
});

test('it handles only its own routes', () => {
  const routes = dashboardRoutes(async () => ({}));
  const [req, res] = fakeCall('/rpc', { method: 'POST' });
  assert.equal(routes(req, res), false, '/rpc must fall through to the broker');
});

test('what needs a person comes first, and an overdue lease is shown, not repaired', async () => {
  const now = 1_000_000;
  const orders = [
    { orderId: 'a', tool: 'ask_user', why: 'approve the brief', role: 'reviewer', attempt: 1, issuedAt: now - 60_000 },
    { orderId: 'b', tool: 'ask_user', why: 'approve the other brief', role: 'reviewer', attempt: 1, issuedAt: now - 600_000 },
    { orderId: 'c', tool: 'deploy', why: 'ship it', role: null, attempt: 1, issuedAt: now - 5_000, claimedBy: 'claude-code/aaaa', claimedUntil: now - 1 },
    { orderId: 'd', tool: 'fetch', why: 'gather', role: null, attempt: 1, issuedAt: now - 5_000, claimedBy: 'claude-code/bbbb', claimedUntil: now + 60_000 },
  ];
  let sweptWith = 'never called';
  const pf = {
    runs: async () => ([{ instanceId: 'polycrew|acme|wf|k', workflow: 'wf', key: 'k', status: 'active', state: { s: 'go' }, seq: 3, done: false }]),
    timers: async () => ([{ key: 'window', action: 'DENIED', fireAt: now + 3_600_000 }]),
  };
  const broker = { open: (_id, opts) => { sweptWith = opts; return orders; } };

  const s = await snapshot({ pf, broker, area: 'acme', actor: 'polycrew/zzzz', now });

  assert.deepEqual(sweptWith, { sweep: false },
    'a page that swept would release the very lease it is meant to report');
  assert.deepEqual(s.needsAHuman.map((o) => o.orderId), ['b', 'a'], 'longest wait first');
  assert.equal(s.unclaimed, 2, 'the two nobody has taken');
  assert.deepEqual(s.overdue.map((o) => o.orderId), ['c']);
  assert.equal(s.runs[0].orders.find((o) => o.orderId === 'd').overdue, false);
  assert.equal(s.runs[0].timers[0].action, 'DENIED');

  const html = page(s);
  assert.match(html, /approve the other brief/);
  assert.match(html, /lease overdue/);
  assert.match(html, /claude-code\/aaaa/);
  assert.match(html, /in 1h 0m/, 'a timer reads as when it fires, not as a number');
});

test('the page escapes what a workflow put in it', async () => {
  const now = 2_000_000;
  const pf = {
    runs: async () => ([{ instanceId: 'i', workflow: '<script>x</script>', key: 'k&k', status: 'active', state: {}, done: false }]),
    timers: async () => [],
  };
  const broker = {
    open: () => ([{ orderId: 'a', tool: '"><img>', why: 'a & b', role: null, attempt: 1, issuedAt: now }]),
  };
  const html = page(await snapshot({ pf, broker, area: 'x', actor: 'y', now }));
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

// -- through the broker a session actually elected ---------------------------

const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 10_000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', reject);
  req.end();
});

test('the page and the JSON say what the tools say', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polycrew-dash-'));
  const s = session({
    POLYCREW_HOME: join(dir, 'home'),
    POLYCREW_DB: join(dir, 'crew.sqlite'),
    POLYCREW_INSTANCE: 'dash-test',
  });
  t.after(() => {
    s.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const started = await s.call('workflow_start', {
    workflow: 'customer-brief', input: { date: '2027-01-01' },
  });
  const order = started.next[0];

  const json = await get(s.port(), '/dashboard.json');
  assert.equal(json.status, 200);
  assert.match(json.type, /application\/json/);
  const facts = JSON.parse(json.body);

  assert.equal(facts.crew, 'dash-test');
  assert.equal(facts.broker, s.actor());
  assert.deepEqual(facts.sessions.map((x) => x.actor), [s.actor()], 'the registry, reaped on read');

  const run = facts.runs.find((r) => r.instanceId === started.instance);
  assert.ok(run, 'the run the tool just started');
  assert.deepEqual(run.state, started.state, 'the same state the tool reports');
  assert.deepEqual(run.orders.map((o) => o.orderId), [order.order_id], 'the same work order');
  assert.equal(run.orders[0].tool, order.tool);
  assert.equal(run.orders[0].claimedBy, null);
  assert.equal(facts.unclaimed, 1);

  // Claiming moves the page, because both read one store.
  await s.call('workflow_claim', { order_id: order.order_id });
  const after = JSON.parse((await get(s.port(), '/dashboard.json')).body);
  assert.equal(after.runs[0].orders[0].claimedBy, s.actor());
  assert.equal(after.unclaimed, 0);
  assert.ok(after.runs[0].orders[0].waitingMs > 0, 'how long it has been waiting, not zero');

  const html = await get(s.port(), '/dashboard');
  assert.equal(html.status, 200);
  assert.match(html.type, /text\/html/);
  assert.match(html.body, /customer-brief/);
  assert.match(html.body, /2027-01-01/);
  assert.match(html.body, new RegExp(order.tool));
  assert.match(html.body, new RegExp(s.actor().replace('/', '\\/')));

  // And the broker's own routes still work beside it.
  assert.equal((await get(s.port(), '/health')).status, 200);
});
