// codemod-target — SAM v2 strict-profile module.
//
// One run per file. A sweep over a monorepo is not one run with fifty orders;
// it is fifty runs with one order open each, and `workflow_next` spans them.
// That is what lets any number of sessions drain the sweep without anyone
// handing out assignments, and what makes the run key — the file path — the
// thing that stops a file being swept twice.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'codemodTarget' });

const INITIAL_STATE = { phase: 'idle', reason: '' };

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent to
// the last-declared name.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      phase: { type: 'string' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      CHANGE_APPLIED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ changed: true }, { changed: false }],
      },
      CHANGE_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ reason: 'edit-failed' }],
      },
      VERIFY_PASSED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      VERIFY_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ reason: 'tests-failed' }],
      },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next }) => {
        if (model.phase !== 'idle') return reject('already-started');
        next.phase = 'editing';
        next.reason = '';
      },
      CHANGE_APPLIED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'editing') return reject('stale-completion');
        if (proposal.changed === false) {
          // Nothing was touched, so there is nothing to verify. Running the
          // suite here would burn a slot and report a pass that means nothing.
          next.phase = 'skipped';
          next.reason = 'no-change-needed';
          return;
        }
        next.phase = 'verifying';
        unchanged('reason');
      },
      CHANGE_FAILED: (model) => (proposal, { reject, next }) => {
        if (model.phase !== 'editing') return reject('stale-completion');
        next.phase = 'failed';
        next.reason = String(proposal.reason || 'edit-failed');
      },
      VERIFY_PASSED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'verifying') return reject('nothing-awaiting-verification');
        next.phase = 'done';
        unchanged('reason');
      },
      VERIFY_FAILED: (model) => (proposal, { reject, next }) => {
        if (model.phase !== 'verifying') return reject('nothing-awaiting-verification');
        next.phase = 'failed';
        next.reason = String(proposal.reason || 'tests-failed');
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
