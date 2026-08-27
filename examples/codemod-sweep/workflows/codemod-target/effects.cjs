// Effect mapper — pure, edge-triggered on state transitions. No I/O, no clock,
// no randomness. In polyflow an "effect" is a WORK ORDER for the agent: the
// runtime never executes it, it hands it back through workflow_next and waits
// for workflow_report.
//
// Two orders per target, and never at the same time: edit the file, then run
// the tests that cover it. The second is emitted only by the transition the
// first one causes, which is what makes "verified" mean something.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const out = [];

  if (entered('editing')) {
    out.push({ kind: 'apply_change', payload: {} });
  }
  if (entered('verifying')) {
    out.push({ kind: 'verify_change', payload: {} });
  }
  return out;
};
