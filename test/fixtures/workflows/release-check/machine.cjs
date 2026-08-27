// release-check — SAM v2 strict-profile module.
//
// The fan-out shape. Three checks run at the same time and report in any
// order; the run leaves 'checking' only when all three have reported, and
// ships only if none of them failed.
//
// Every not-applicable action is an observable reject(reason). That matters
// more here than in a sequential workflow: several agents share these orders,
// so a duplicate report, a report of a check that already landed, or a report
// arriving after the run moved on are all ordinary events, not faults.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'releaseCheck' });

const INITIAL_STATE = { phase: 'idle', checksDone: 0, failures: 0, reason: '' };
const CHECKS = 3;

/** Where the run goes once the last check has reported. */
const settle = (next, failures) => {
  if (failures > 0) {
    next.phase = 'blocked';
    next.reason = 'a-check-failed';
    return;
  }
  next.phase = 'shipping';
  next.reason = '';
};

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent to
// the last-declared name.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      phase: { type: 'string' },
      checksDone: { type: 'number' },
      failures: { type: 'number' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      CHECK_PASSED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ check: 'security' }, { check: 'tests' }, { check: 'licences' }],
      },
      CHECK_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [
          { check: 'security', reason: 'found-a-problem' },
          { check: 'tests', reason: 'found-a-problem' },
          { check: 'licences', reason: 'found-a-problem' },
        ],
      },
      PUBLISHED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PUBLISH_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ reason: 'registry-unavailable' }],
      },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'idle') return reject('already-started');
        next.phase = 'checking';
        next.checksDone = 0;
        next.failures = 0;
        next.reason = '';
      },
      CHECK_PASSED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'checking') return reject('stale-completion');
        const done = model.checksDone + 1;
        next.checksDone = done;
        unchanged('failures');
        if (done < CHECKS) {
          next.phase = 'checking';
          unchanged('reason');
          return;
        }
        settle(next, model.failures);
      },
      CHECK_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'checking') return reject('stale-completion');
        const done = model.checksDone + 1;
        const failures = model.failures + 1;
        next.checksDone = done;
        next.failures = failures;
        if (done < CHECKS) {
          // Not blocked yet: the other checks are still running, and their
          // reports are still wanted. Failing fast here would leave two open
          // orders belonging to a run nobody can finish.
          next.phase = 'checking';
          unchanged('reason');
          return;
        }
        settle(next, failures);
      },
      PUBLISHED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'shipping') return reject('nothing-awaiting-publish');
        next.phase = 'shipped';
        unchanged('checksDone', 'failures', 'reason');
      },
      PUBLISH_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'shipping') return reject('nothing-awaiting-publish');
        next.phase = 'failed';
        next.reason = String(proposal.reason || 'publish-failed');
        unchanged('checksDone', 'failures');
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  try {
    const model = instance({}).state();
    if (model && typeof model.clearError === 'function') model.clearError();
  } catch { /* best-effort; strict-profile errors throw at the caller anyway */ }
  setState(INITIAL_STATE);
};

const actions = Object.fromEntries(
  Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)])
);

module.exports = { instance, init, actions, getState, setState };
