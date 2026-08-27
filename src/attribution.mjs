// Who caused each step of a run.
//
// polyrun's journal records what happened; it does not record who asked. C0
// does not change polyrun's schema, so polycrew keeps the mapping in its own
// store and joins it on read.
//
// Nothing here is inferred by reading the journal back after the fact. A
// wrapper that ran the call and then looked for the newest row would attribute
// another session's step to whoever read last — which is exactly the mistake
// this layer exists to prevent. Every row is recorded by the call that caused
// it, keyed by something that call already knows:
//
//   $create, $create:action    the run starting          -> the starter
//   <orderId>:done             a work order completed    -> the reporter
//   #<seq>                     an out-of-band signal     -> the caller
//
// The first two are action ids the engine derives, known before the step
// exists. A signal's action id is a fresh uuid the kernel mints, so the seq the
// call returned identifies its row instead. Both forms are exact.
//
// Two kinds of step have no actor at all, and are labelled rather than guessed:
//
//   timer:<timerId>            a timer firing            -> system/timer
//   child:<instance>:complete  a child reaching terminal -> system/child:...

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pf_actors (
  instance_id TEXT NOT NULL,
  ref         TEXT NOT NULL,
  actor       TEXT NOT NULL,
  via         TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (instance_id, ref)
);
`;

/** How a journal row refers to itself when a signal produced it. */
const bySeq = (seq) => `#${seq}`;

/** The machine acting on its own, rather than an actor who could be named. */
export function systemActor(actionId = '') {
  if (actionId.startsWith('timer:')) return { actor: 'system/timer', via: 'timer' };
  const child = /^child:(.+):complete$/.exec(actionId);
  if (child) return { actor: `system/child:${child[1]}`, via: 'child' };
  return null;
}

export class Attribution {
  /**
   * @param {object} o
   * @param {import('node:sqlite').DatabaseSync} o.db  polycrew's store — the
   *   SAME handle the order store uses, so the crew keeps one writer per file.
   * @param {function} o.now  injectable clock
   */
  constructor({ db, now = () => Date.now() }) {
    this.db = db;
    this.now = now;
    this.db.exec(SCHEMA);
  }

  /**
   * Record who caused a step. Idempotent on (instance, ref): the FIRST actor
   * to cause a step is the one that caused it, and a retry of the same call
   * must not rewrite history.
   */
  record(instanceId, ref, actor, via) {
    if (!instanceId || !ref || !actor) return false;
    // ON CONFLICT DO NOTHING, not INSERT OR IGNORE. OR IGNORE swallows EVERY
    // constraint violation, not the one meant here: a missing timestamp made
    // every write fail NOT NULL and return quietly, and the store stayed empty
    // with nothing raised anywhere. This ignores the duplicate and nothing else.
    return this.db.prepare(
      'INSERT INTO pf_actors (instance_id, ref, actor, via, at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (instance_id, ref) DO NOTHING',
    ).run(instanceId, ref, actor, via ?? 'unknown', this.now()).changes > 0;
  }

  /** Every reference recorded for one run. */
  forInstance(instanceId) {
    const rows = this.db.prepare('SELECT ref, actor, via FROM pf_actors WHERE instance_id = ?')
      .all(instanceId);
    return new Map(rows.map((r) => [r.ref, { actor: r.actor, via: r.via }]));
  }

  /**
   * Add `actor` and `via` to journal rows. A row nobody claimed, and that the
   * machine did not obviously cause, reads `unattributed` — a wrong name in an
   * audit trail is worse than a missing one.
   */
  join(instanceId, rows = []) {
    const known = this.forInstance(instanceId);
    return rows.map((r) => {
      const found = known.get(r.action_id)
        ?? known.get(bySeq(r.seq))
        ?? systemActor(r.action_id)
        ?? { actor: 'unattributed', via: 'unknown' };
      return { ...r, actor: found.actor, via: found.via };
    });
  }
}

/** The two fields the journal gains, in polyflow’s plain schema subset. */
export const ATTRIBUTED_ROW = {
  actor: {
    type: 'string',
    description: 'who caused this step: an actor id, system/timer for a timer, '
      + 'system/child:<instance> for a child finishing, or unattributed',
  },
  via: { type: 'string', description: 'how: start, report, signal, timer or child' },
};

/**
 * Wrap the tools that cause steps so each records its actor, and the journal
 * reads it back. Attribution lives here rather than in polyflow because the
 * actor is polycrew's concept: polyflow's own server has one caller and
 * nothing to tell apart.
 *
 * @param {object[]} tools  the tool list from makeTools
 * @param {Attribution} log
 * @returns {object[]} the same tools, four of them wrapped
 */
export function attributing(tools, log) {
  const wrap = (name, fn) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`cannot attribute '${name}': no such tool`);
    return [name, { ...tool, handler: (args = {}, actor) => fn(tool, args, actor) }];
  };

  const wrapped = new Map([
    // Starting a run is two rows: the instance being created, and the START
    // action itself. Both belong to whoever asked for the run.
    wrap('workflow_start', async (tool, args, actor) => {
      const v = await tool.handler(args, actor);
      if (v?.instance && actor) {
        log.record(v.instance, '$create', actor, 'start');
        log.record(v.instance, '$create:action', actor, 'start');
      }
      return v;
    }),

    // A completion's action id is derived from the order id, so it is known
    // before the step exists. A refused report caused no step and records none.
    wrap('workflow_report', async (tool, args, actor) => {
      const v = await tool.handler(args, actor);
      if (v?.instance && actor && args.order_id && !v.error) {
        log.record(v.instance, `${args.order_id}:done`, actor, 'report');
      }
      return v;
    }),

    // A rejected signal is still a journal row, and still worth attributing:
    // knowing who tried something the run refused is the point of an audit.
    wrap('workflow_signal', async (tool, args, actor) => {
      const v = await tool.handler(args, actor);
      if (v?.instance && actor && Number.isInteger(v.step_seq)) {
        log.record(v.instance, bySeq(v.step_seq), actor, 'signal');
      }
      return v;
    }),

    wrap('workflow_journal', async (tool, args, actor) => {
      const v = await tool.handler(args, actor);
      return v?.journal ? { ...v, journal: log.join(args.instance, v.journal) } : v;
    }),
  ]);

  // The journal's own schema grows two fields, so a host that validates
  // structuredContent against it does not drop what we just added.
  const journal = wrapped.get('workflow_journal');
  const items = journal.outputSchema?.properties?.journal?.items;
  if (items) {
    journal.outputSchema = {
      ...journal.outputSchema,
      properties: {
        ...journal.outputSchema.properties,
        journal: {
          ...journal.outputSchema.properties.journal,
          items: { ...items, properties: { ...items.properties, ...ATTRIBUTED_ROW } },
        },
      },
    };
  }

  return tools.map((t) => wrapped.get(t.name) ?? t);
}
