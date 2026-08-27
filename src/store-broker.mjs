// A broker whose orders live in a table instead of one process's memory.
//
// This is the half of polyflow that changes when a crew shares a run. It
// satisfies the same contract (broker.mjs: handler, open, orderById, issued,
// report, abort) and adds what a crew needs: claiming, leases, and offering
// work to whoever may do it.
//
// The parked promise stays in memory on purpose. Only the elected broker runs
// handlers (spec MA-22), so a promise is never stranded in another process —
// what has to be shared is the ORDER, and that is the table.
//
// Two leases, deliberately not the same one. polyrun's outbox lease belongs to
// its worker and covers the effect; the claim below belongs to an actor and
// covers the order. Conflating them would make both mean less.

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pf_orders (
  order_id      TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  tool          TEXT NOT NULL,
  target        TEXT,
  args          TEXT NOT NULL,
  why           TEXT NOT NULL DEFAULT '',
  role          TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL,
  claimed_by    TEXT,
  claimed_until INTEGER,
  issued_at     INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS pf_orders_open ON pf_orders (instance_id, status);
CREATE INDEX IF NOT EXISTS pf_orders_claim ON pf_orders (status, claimed_by);
`;

export function openOrderStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

const OPEN = 'open';

/** A row as the tool surface wants it. */
const view = (r) => ({
  orderId: r.order_id,
  instanceId: r.instance_id,
  kind: r.kind,
  tool: r.tool,
  target: r.target ?? null,
  args: JSON.parse(r.args),
  why: r.why,
  role: r.role ?? null,
  attempt: r.attempt,
  status: r.status,
  claimedBy: r.claimed_by ?? null,
  claimedUntil: r.claimed_until ?? null,
  issuedAt: r.issued_at,
  closedAt: r.closed_at ?? null,
});

export class StoreBroker {
  /**
   * @param {object}   o
   * @param {string}   o.dbPath     order store path, or ':memory:'
   * @param {number}   o.leaseMs    how long a claim holds without renewal
   * @param {function} o.now        injectable clock, so leases are testable
   */
  constructor({ dbPath = ':memory:', leaseMs = 5 * 60_000, now = () => Date.now(), heartbeatMs = 60_000 } = {}) {
    this.db = openOrderStore(dbPath);
    this.leaseMs = leaseMs;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.pending = new Map(); // orderId -> { resolve, reject, timer }
  }

  // -- the polyflow broker contract ------------------------------------------

  handler(kind, spec = {}) {
    return (payload, intentId, ctx) => new Promise((resolve, reject) => {
      const at = this.now();
      this.db.prepare(`
        INSERT INTO pf_orders (order_id, instance_id, kind, tool, target, args, why, role,
                               attempt, status, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          attempt = excluded.attempt, status = excluded.status,
          claimed_by = NULL, claimed_until = NULL, closed_at = NULL
      `).run(
        intentId, ctx.instanceId, kind, spec.tool ?? kind, spec.target ?? null,
        JSON.stringify(payload ?? {}), spec.why ?? '', spec.role ?? null,
        ctx.attempt, OPEN, at,
      );

      // The agent is the callback and may take turns, not milliseconds.
      const timer = setInterval(() => { ctx.extendLease(this.heartbeatMs * 2).catch(() => {}); },
        this.heartbeatMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(intentId, { resolve, reject, timer });
    });
  }

  /**
   * Open orders for one run.
   *
   * `sweep: false` reads without releasing lapsed claims. The dashboard needs
   * it: sweeping is a repair, and a page that repaired what it was reporting
   * on could never show a lease going overdue — which is the one thing a
   * person watching a crew is watching for.
   */
  open(instanceId, { sweep = true } = {}) {
    if (sweep) this.sweep();
    return this.db.prepare(
      'SELECT * FROM pf_orders WHERE instance_id = ? AND status = ? ORDER BY issued_at',
    ).all(instanceId, OPEN).map(view);
  }

  orderById(orderId) {
    const row = this.db.prepare('SELECT * FROM pf_orders WHERE order_id = ?').get(orderId);
    return row ? view(row) : undefined;
  }

  issued(instanceId) {
    return this.db.prepare('SELECT * FROM pf_orders WHERE instance_id = ? ORDER BY issued_at')
      .all(instanceId).map(view);
  }

  /**
   * Settle an order. `actor` is checked against the claim when one is held —
   * an order nobody claimed can be reported by anyone, which is what keeps a
   * single-agent run working unchanged.
   */
  report(orderId, { ok = true, result = {}, error = '', permanent = false, actor = null } = {}) {
    this.sweep();
    const row = this.db.prepare('SELECT * FROM pf_orders WHERE order_id = ?').get(orderId);
    if (!row) return { ok: false, reason: 'unknown-order' };
    if (row.status !== OPEN) {
      return { ok: false, reason: 'order-expired', hint: 'call workflow_next again' };
    }
    if (row.claimed_by && actor && row.claimed_by !== actor) {
      return { ok: false, reason: 'not-your-order', holder: row.claimed_by };
    }

    const waiter = this.pending.get(orderId);
    if (!waiter) {
      // The broker that parked this handler is gone. The effect lease will
      // expire and re-offer it; reporting into nothing would lose the result.
      return { ok: false, reason: 'order-expired', hint: 'call workflow_next again' };
    }

    clearInterval(waiter.timer);
    this.pending.delete(orderId);
    this.db.prepare('UPDATE pf_orders SET status = ?, closed_at = ? WHERE order_id = ?')
      .run(ok ? 'done' : 'failed', this.now(), orderId);

    if (ok) waiter.resolve(result && typeof result === 'object' ? result : { value: result });
    else waiter.reject(Object.assign(new Error(error || 'tool failed'), { permanent }));
    return { ok: true };
  }

  /** Shutdown: fail every parked handler. Rows stay OPEN — a new broker re-offers them. */
  abort(reason = 'polycrew shutting down') {
    for (const [, w] of this.pending) {
      clearInterval(w.timer);
      w.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // -- what a crew adds ------------------------------------------------------

  /** Release claims nobody renewed. The order stays open; only the holder is dropped. */
  sweep(at = this.now()) {
    const { changes } = this.db.prepare(
      'UPDATE pf_orders SET claimed_by = NULL, claimed_until = NULL '
      + 'WHERE status = ? AND claimed_until IS NOT NULL AND claimed_until <= ?',
    ).run(OPEN, at);
    return changes;
  }

  /**
   * Open, unclaimed orders this actor may take. `roles` is the set the calling
   * session was started with; an order with no role is open to anyone, which
   * is how a single-participant run keeps working.
   */
  offers({ instanceId = null, roles = [] } = {}) {
    this.sweep();
    const rows = instanceId
      ? this.db.prepare(
        'SELECT * FROM pf_orders WHERE status = ? AND claimed_by IS NULL AND instance_id = ? ORDER BY issued_at',
      ).all(OPEN, instanceId)
      : this.db.prepare(
        'SELECT * FROM pf_orders WHERE status = ? AND claimed_by IS NULL ORDER BY issued_at',
      ).all(OPEN);
    const allowed = new Set(roles);
    return rows.filter((r) => !r.role || allowed.has(r.role)).map(view);
  }

  /**
   * Take an order. Re-claiming one you already hold renews it, so a long order
   * is held by working on it rather than by a separate keep-alive.
   */
  claim(orderId, actor, { roles = [] } = {}) {
    this.sweep();
    const row = this.db.prepare('SELECT * FROM pf_orders WHERE order_id = ?').get(orderId);
    if (!row) return { ok: false, reason: 'unknown-order' };
    if (row.status !== OPEN) return { ok: false, reason: 'order-expired' };
    if (row.role && !roles.includes(row.role)) {
      return { ok: false, reason: 'not-your-role', role: row.role };
    }
    if (row.claimed_by && row.claimed_by !== actor) {
      return {
        ok: false, reason: 'claimed-by-other',
        holder: row.claimed_by, until: row.claimed_until,
        hint: 'call workflow_next for something else',
      };
    }
    const until = this.now() + this.leaseMs;
    this.db.prepare('UPDATE pf_orders SET claimed_by = ?, claimed_until = ? WHERE order_id = ?')
      .run(actor, until, orderId);
    return { ok: true, order: { ...view(row), claimedBy: actor, claimedUntil: until } };
  }

  /** Extend a claim the actor still holds. Anything else is a refusal, not a renewal. */
  renew(orderId, actor) {
    this.sweep();
    const row = this.db.prepare('SELECT * FROM pf_orders WHERE order_id = ?').get(orderId);
    if (!row || row.status !== OPEN) return { ok: false, reason: 'order-expired' };
    if (row.claimed_by !== actor) return { ok: false, reason: 'not-your-order', holder: row.claimed_by };
    const until = this.now() + this.leaseMs;
    this.db.prepare('UPDATE pf_orders SET claimed_until = ? WHERE order_id = ?').run(until, orderId);
    return { ok: true, until };
  }

  close() {
    this.abort('closing');
    this.db.close();
  }
}
