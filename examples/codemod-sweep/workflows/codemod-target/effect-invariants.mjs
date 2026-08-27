// What this workflow may EMIT, on every reachable path — the admission gate.
//
// A sweep is dangerous in a specific way: it edits files. The two things that
// can go wrong are editing a file twice and calling a change verified when
// nothing ran. Neither is something a reviewer can establish by reading the
// worker prompt, because a prompt is a request, not a guarantee. These are the
// sentences instead, and startup enumerates every reachable path over the
// contract's declared domain to prove them before the workflow is registered.
'use strict';

export const effectInvariants = [
  {
    // The one that matters. A second edit order for a file another actor is
    // already editing is the whole failure mode of a shared sweep.
    name: 'at-most-one-edit-per-file',
    pred: (path) => path.count('apply_change') <= 1,
  },
  {
    // Tests are expensive. Running them twice for one file is waste, not risk,
    // but a sweep over a large repo is mostly the cost of its test runs.
    name: 'at-most-one-verification-per-file',
    pred: (path) => path.count('verify_change') <= 1,
  },
  {
    // "Verified" has to mean the tests ran against a change that was made.
    // Nothing may be verified on a path where no edit was ever emitted.
    name: 'verification-implies-a-prior-edit',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'verify_change'
      || path.emitted.some((a) => a.kind === 'apply_change' && a.step < e.step)),
  },
  {
    // A file that turned out not to need the change is finished, not tested.
    name: 'nothing-is-verified-after-a-skip',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'verify_change' || !path.actionBefore('CHANGE_APPLIED', i)
      || path.actions.some((a) => a.action === 'CHANGE_APPLIED' && a.data
        && a.data.changed === true)),
  },
  {
    // Every started target is offered exactly one edit. Zero would mean a
    // target silently doing nothing; more than one is the first rule again,
    // from the other side.
    name: 'exactly-one-edit-when-started',
    pred: (path) => {
      const started = path.actions.some((a) => a.action === 'START');
      return path.count('apply_change') === (started ? 1 : 0);
    },
  },
];
