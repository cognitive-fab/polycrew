# C0 step 8 — acceptance

Two real `claude` sessions, one project, one release. No supervisor, no
assignment, and no channel between them: each only ever talked to the run.

## What was run

A temp project with an `.mcp.json` naming polycrew as its only MCP server, and
`release-check` as the library — a workflow that emits **three work orders in a
single step**, then publishes only if all three pass. Every earlier step used
`customer-brief`, which is sequential: one order open at a time, so two sessions
could only ever contend for the same one. Fan-out is the shape a crew is for.

Both sessions were started at the same moment with the same prompt. Neither was
told the other existed beyond "another agent is working the same release"; both
were told to start the run, take work with `workflow_next` / `workflow_claim`,
and — the one instruction that matters — **not to retry a claim that came back
`claimed: false`**.

Nothing was executed for real. The checks are simulated; reporting the order was
the work.

## What happened

Read back from the crew's own store afterwards, not from what the models said
about themselves:

```
run      : claude-code|acceptance|release-check|2.4.0
phase    : shipped | checksDone 3 | failures 0 | done true

seq  action          actor                     via
0    $create         claude-code/8c6f1db6      start
1    START           claude-code/8c6f1db6      start
2    CHECK_PASSED    claude-code/8c6f1db6      report
3    CHECK_PASSED    claude-code/82b4feb2      report
4    CHECK_PASSED    claude-code/82b4feb2      report
5    PUBLISHED       claude-code/8c6f1db6      report

completions     : 4
distinct actors : 2 -> claude-code/8c6f1db6, claude-code/82b4feb2
any order twice?: false
```

Four properties, all of them the point of the thing:

**One run, though both sessions started one.** Both models called
`workflow_start` for version 2.4.0. There is one `$create`. The run identity is
derived from the input, so the second start re-attached to the first run rather
than opening a second — neither model was in a position to name a run, so
neither could name a different one.

**Four orders, four completions, no duplicates.** Three checks and the publish
that follows them, each done exactly once, by two agents who never coordinated.

**Two identities neither session chose.** `8c6f1db6` and `82b4feb2` were minted
by the two server processes at boot. No tool schema has a field for an actor,
so neither model could have claimed to be the other, or invented a second self.

**The work split without anyone splitting it.** 8c6f1db6 took one check and the
publish; 82b4feb2 took the other two checks. Nobody assigned that.

## The instruction that carried the weight

Both sessions hit a refused claim and both moved on. From their own summaries:

> of the three check orders, the vulnerability scan and the publish step were
> claimed by the other agent, so I didn't retry them

> the test-suite and licence-check orders were claimed by the other agent (I did
> not retry them)

This is the reason `workflow_claim` answers `claimed: false` with a holder and a
hint instead of raising an error. A model that receives an error retries the
call it just made; a model that receives an answer goes and finds other work.
The distinction was a design guess in step 5 and it survived contact with a real
model on the first attempt.

## What this run does NOT show

**The kill case.** "Kill one session mid-order and the other takes it" is
covered by `test/acceptance.test.mjs` — real processes, SIGKILL, a lease that
lapses, and a survivor that claims the abandoned order and finishes the release
— but not with a live model driving it. Orchestrating a kill at the right
instant inside a model's turn is a harness problem, not a polycrew one, and the
property being tested is in the store either way.

**Contention was not forced.** Two sessions racing for three orders is a real
race, but it is a small one; a wider fan-out with more sessions would exercise
it harder. Every claim that was refused in this run was refused correctly, and
no order was done twice — but that is four orders, not four hundred.

**Nothing real was executed.** The checks are simulated. This run says the
coordination holds; it says nothing about the workflows themselves.

## Reproducing it

`test/acceptance.test.mjs` is the scripted half and runs on every commit with no
model and no cost. The live half needs an API key:

```
POLYCREW_WORKFLOWS=<repo>/test/fixtures/workflows   # the release-check library
POLYCREW_INSTANCE=acceptance                         # one crew
```

Point two `claude -p` sessions at an `.mcp.json` naming `bin/polycrew.mjs` with
that environment, give both the prompt above, and read the journal afterwards
with `workflow_journal`.
