// Effect mapper — pure, edge-triggered on state transitions. No I/O, no clock,
// no randomness. In polyflow an "effect" is a WORK ORDER for the agent: the
// runtime never executes it, it hands it back through workflow_next and waits
// for workflow_report.
//
// Entering 'checking' emits THREE orders in one step. That is the whole point
// of this workflow: three pieces of work exist at the same moment, addressed to
// nobody in particular, and a crew of any size shares them by claiming.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const out = [];

  if (entered('checking')) {
    out.push({ kind: 'check_security', payload: {} });
    out.push({ kind: 'check_tests', payload: {} });
    out.push({ kind: 'check_licences', payload: {} });
  }
  if (entered('shipping')) {
    out.push({ kind: 'publish_release', payload: {} });
  }
  return out;
};
