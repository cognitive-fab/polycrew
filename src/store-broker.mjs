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
  closed_at     INTEGER,
  -- A result that was reported while no handler was parked to receive it.
  -- Kept HERE rather than dropped, so a piece of work that was actually done
  -- is never done a second time just because a process exited.
  result_json      TEXT,
  result_ok        INTEGER,
  result_error     TEXT,
  result_permanent INTEGER,
  reported_by      TEXT,
  reported_at      INTEGER
);
CREATE INDEX IF NOT EXISTS pf_orders_open ON pf_orders (instance_id, status);
CREATE INDEX IF NOT EXISTS pf_orders_claim ON pf_orders (status, claimed_by);
`;

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS misses them. */
const ADDED = {
  result_json: 'TEXT', result_ok: 'INTEGER', result_error: 'TEXT',
  result_permanent: 'INTEGER', reported_by: 'TEXT', reported_at: 'INTEGER',
};

export function openOrderStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  // A store written by an older build has the table but not these columns, and
  // an open sweep in it is exactly the thing worth not losing.
  const have = new Set(db.prepare('PRAGMA table_info(pf_orders)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(ADDED)) {
    if (!have.has(col)) db.exec(`ALTER TABLE pf_orders ADD COLUMN ${col} ${type}`);
  }
  return db;
}

const OPEN = 'open';
// Done by an actor and written down, but not yet handed to the engine: the
// broker that would have received it is gone. The next time the engine offers
// this order, the stored result settles it immediately.
const REPORTED = 'reported';

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
      // Read BEFORE the upsert: a result reported into a dead broker is
      // waiting on this row, and the upsert is about to reset the status.
      const prior = this.db.prepare('SELECT * FROM pf_orders WHERE order_id = ?').get(intentId);
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

      // Somebody already did this work and wrote the answer down while no
      // broker was listening. Deliver it now rather than offering the order to
      // a second actor, which is how the same work gets done twice.
      if (prior && prior.status === REPORTED) {
        this.db.prepare('UPDATE pf_orders SET status = ?, closed_at = ? WHERE order_id = ?')
          .run(prior.result_ok ? 'done' : 'failed', this.now(), intentId);
        if (prior.result_ok) {
          const value = prior.result_json ? JSON.parse(prior.result_json) : {};
          resolve(value && typeof value === 'object' ? value : { value });
        } else {
          reject(Object.assign(new Error(prior.result_error || 'tool failed'),
            { permanent: Boolean(prior.result_permanent) }));
        }
        return;
      }

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
    if (row.status === REPORTED) {
      // Recorded once already. A second report must not overwrite the first,
      // any more than a second report of a live order may.
      return {
        ok: false,
        reason: 'already-reported',
        holder: row.reported_by,
        hint: 'this order was already done and written down; call workflow_next for other work',
      };
    }
    if (row.status !== OPEN) {
      return { ok: false, reason: 'order-expired', hint: 'call workflow_next again' };
    }
    if (row.claimed_by && actor && row.claimed_by !== actor) {
      return { ok: false, reason: 'not-your-order', holder: row.claimed_by };
    }

    const waiter = this.pending.get(orderId);
    if (!waiter) {
      // The broker that parked this handler is gone — this process opened the
      // store afterwards, so the ROW is here but the promise is not.
      //
      // Refusing here would throw away work that was actually done: the agent
      // has already changed the file, run the tests, sent the message. The
      // order would later be re-offered and somebody would do it AGAIN, which
      // is the one thing this whole design exists to prevent. So write the
      // result down instead. The next time the engine offers this order, the
      // handler settles from it immediately and nobody is asked to repeat it.
      this.db.prepare(`
        UPDATE pf_orders SET status = ?, result_json = ?, result_ok = ?, result_error = ?,
                             result_permanent = ?, reported_by = ?, reported_at = ?
        WHERE order_id = ?
      `).run(
        REPORTED, JSON.stringify(result ?? {}), ok ? 1 : 0, error || null,
        permanent ? 1 : 0, actor ?? null, this.now(), orderId,
      );
      return {
        ok: true,
        deferred: true,
        hint: 'recorded — the broker that was waiting for this is gone, so the run takes it '
          + 'up when the engine next offers the order. Do not do this work again.',
      };
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
