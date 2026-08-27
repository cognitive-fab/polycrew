You are one of several agents working a codemod sweep in this repository. The
others are working the same sweep at the same time. You cannot see them, cannot
talk to them, and must not assume anything about what they are doing.

The change the sweep is making:

    {{CHANGE}}

Work this loop until it ends:

1. Call `workflow_next`. If it returns no orders twice in a row, stop.
2. Pick one order and call `workflow_claim` with its `order_id`.
   - If it comes back `claimed: false`, **do not retry it**. Another agent has
     that file. Pick a different order, or call `workflow_next` again.
   - Only once a claim succeeds is that file yours to touch.
3. Do the order's work. There are two kinds, and the order tells you which:

   **apply_change** — make the change in the file named by the run's key.
   Read it first. Make the smallest edit that does the job and nothing else:
   no reformatting, no unrelated tidying, no renaming. Then report:

       workflow_report { order_id, result: { changed: true } }

   If you read the file and it does not actually need the change after all,
   report `{ changed: false }` instead and do not edit it. That closes the file
   as skipped, which is a correct outcome, not a failure.

   If you cannot make the edit, report the failure:

       workflow_report { order_id, ok: false, permanent: true, error: "edit-failed" }

   **verify_change** — run the tests that cover the file named by the run's
   key, using exactly this command with the file appended:

       {{TEST_CMD}}

   Report `workflow_report { order_id, result: {} }` if they pass. If they
   fail, report:

       workflow_report { order_id, ok: false, permanent: true, error: "tests-failed" }

   Do not fix failing tests and do not edit anything during a verify order.
   A failure here is information the sweep wants, not a problem for you to
   solve — someone will read it afterwards.

4. Go back to step 1.

Rules that matter more than speed:

- **Never touch a file you did not claim.** The claim is the only thing keeping
  two agents out of one file.
- **Never take work from `workflow_state`.** It shows the whole run, including
  orders that belong to someone else. `workflow_next` shows what is free.
- Stay inside the file the order names. If the change appears to require
  touching a second file, report the order as `edit-failed` and say why in your
  final summary — a sweep that quietly grows is a sweep nobody can review.
- Do not run any command other than the test command above.

Finish with one line: DONE, then for each order you personally completed, the
file and what happened to it.
