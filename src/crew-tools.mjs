// The two tools a crew needs that a single agent does not.
//
// polyflow's six tools answer "what is this run, and what should I do next in
// it". They assume the caller is the only one working. Two more close the gap:
//
//   workflow_next   what may I do, across every run in this crew
//   workflow_claim  take one, so nobody else starts the same work
//
// Neither takes an actor. The server minted one at boot and passes it beside
// the arguments, because anything a model can name, a model can name wrongly —
// a session that could supply an actor could report as another one, and a
// session that could supply roles could attach as a reviewer and satisfy its
// own approval gate (spec MA-1, MA-3).
//
// A refused claim is a RESULT, not an error. Two sessions reaching for the same
// order is the normal case, not a fault, and a model that receives an error
// retries; a model that receives `claimed: false, hint: call workflow_next`
// goes and does something else.

import { Area } from 'polyflow/areas';

const obj = (properties, description) => ({ type: 'object', properties, description });

/** Absent is representable in the plain schema subset; null is not. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** One order as an actor sees it — with the run it belongs to, which `next` spans. */
const offer = (o) => {
  const { workflow, key } = Area.parse(o.instanceId);
  return compact({
    order_id: o.orderId,
    instance: o.instanceId,
    workflow,
    key,
    tool: o.tool,
    target: o.target,
    args: o.args,
    why: o.why,
    role: o.role,
    attempt: o.attempt,
    claimed_by: o.claimedBy,
    claimed_until: o.claimedUntil,
  });
};

const OFFER = {
  type: 'object',
  properties: {
    order_id: { type: 'string', description: 'pass this to workflow_claim, then to workflow_report' },
    instance: { type: 'string', description: 'the run this order belongs to' },
    workflow: { type: 'string' },
    key: { type: 'string', description: 'the name identifying that run' },
    tool: { type: 'string', description: 'the tool to call' },
    target: { type: 'string', description: 'what to call it against' },
    args: { type: 'object', description: 'arguments for the call' },
    why: { type: 'string', description: 'why this step exists' },
    role: { type: 'string', description: 'the kind of participant this order is addressed to' },
    attempt: { type: 'number', description: '1 on the first offer, higher after a retry' },
    claimed_by: { type: 'string', description: 'the actor holding it; absent means nobody' },
    claimed_until: { type: 'number', description: 'when that claim lapses if it is not renewed' },
  },
};

/**
 * @param {object} o
 * @param {object} o.broker  the crew's StoreBroker (offers/claim)
 * @param {string[]} o.roles this session's roles, read from the environment at boot
 */
export function crewTools({ broker, roles = [] }) {
  return [
    {
      name: 'workflow_next',
      outputSchema: obj({
        orders: { type: 'array', items: OFFER, description: 'open orders you may take' },
        hint: { type: 'string' },
      }, 'the work this session is allowed to do right now'),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Open, unclaimed work orders you may take — across every run in this crew, or one run if '
        + 'you name it. Others are working the same runs, so this is the only reliable way to pick '
        + 'up work: never choose an order from workflow_state, which shows orders that belong to '
        + 'someone else too. Claim what you take with workflow_claim before doing it. An empty '
        + 'list means nothing is free right now, not that the work is finished.',
      inputSchema: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: 'only this run; omit for every run in the crew' },
        },
      },
      handler: async ({ instance } = {}) => {
        const orders = broker.offers({ instanceId: instance ?? null, roles }).map(offer);
        return compact({
          orders,
          hint: orders.length ? 'claim one with workflow_claim before you run it' : undefined,
        });
      },
    },
    {
      name: 'workflow_claim',
      outputSchema: obj({
        claimed: { type: 'boolean' },
        order: OFFER,
        claimed_until: { type: 'number', description: 'the claim lapses then unless you renew it' },
        reason: { type: 'string', description: 'present when claimed is false' },
        holder: { type: 'string', description: 'who has it instead' },
        hint: { type: 'string' },
      }, 'whether this order is now yours'),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Take an open order so no other session starts the same work. Do this BEFORE running the '
        + 'tool, not after. Re-claiming an order you already hold renews it, so a long job is held '
        + 'by working on it. `claimed: false` is an answer, not a failure — someone else got there '
        + 'first, and the right move is workflow_next for something else, never a retry of this '
        + 'call. Only the holder may report the order.',
      inputSchema: {
        type: 'object',
        required: ['order_id'],
        properties: { order_id: { type: 'string', description: 'from workflow_next' } },
      },
      handler: async ({ order_id }, actor) => {
        const got = broker.claim(order_id, actor, { roles });
        if (!got.ok) {
          return compact({
            claimed: false,
            reason: got.reason,
            holder: got.holder,
            claimed_until: got.until,
            hint: got.hint ?? 'call workflow_next for something you can do instead',
          });
        }
        return compact({
          claimed: true,
          order: offer(got.order),
          claimed_until: got.order.claimedUntil,
        });
      },
    },
  ];
}
