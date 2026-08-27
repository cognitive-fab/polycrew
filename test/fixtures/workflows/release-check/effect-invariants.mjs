// What this workflow may EMIT, on every reachable path — the admission gate.
//
// The fan-out version of the question. With three orders open at once and any
// number of agents free to take them, "did we publish something that failed a
// check" is not a thing a reviewer can establish by reading the code. These
// rules say it, and the check enumerates every reachable path over the
// contract's declared domain to prove it before the workflow is registered.
'use strict';

const CHECKS = ['check_security', 'check_tests', 'check_licences'];

export const effectInvariants = [
  {
    // The double-publish class, before it can happen: no path ships twice.
    name: 'at-most-one-publish-per-path',
    pred: (path) => path.count('publish_release') <= 1,
  },
  {
    // The rule that makes the fan-out worth running: nothing is published on a
    // path where any check reported a problem. Not "we check first" — that is
    // ordering, and ordering is not the property. This is the outcome.
    name: 'no-publish-after-any-failed-check',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'publish_release' || !path.actionBefore('CHECK_FAILED', i)),
  },
  {
    // ...and every one of the three must actually have been asked for. A path
    // that published having only run two checks satisfies the rule above by
    // accident, because the third never got the chance to fail.
    name: 'publish-implies-all-three-checks-were-run',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'publish_release'
      || CHECKS.every((c) => path.emitted.some((r) => r.kind === c && r.step < e.step))),
  },
  {
    // Each check is offered exactly once per started run. A re-emitted check is
    // a second order for work already done, which two agents would then both
    // pick up — the duplicate this whole design exists to prevent.
    name: 'each-check-offered-exactly-once-when-started',
    pred: (path) => {
      const started = path.actions.some((a) => a.action === 'START');
      return CHECKS.every((c) => path.count(c) === (started ? 1 : 0));
    },
  },
];
