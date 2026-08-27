# A codemod sweep, run by a crew

A change you want in fifty files. Several headless Claude Code agents make it,
sharing the work with no supervisor and no assignment — and no file is edited
twice, because that is a rule the workflow was admitted under rather than an
instruction in a prompt.

This example is a working script, not a sketch. Point it at a real monorepo and
it runs.

```bash
examples/codemod-sweep/bin/sweep.sh \
  --repo ../my-monorepo \
  --change "replace moment() with dayjs()" \
  --match "moment(" \
  --test-cmd "node scripts/check.mjs" \
  --workers 3 --limit 10
```

Without `--yes` it prints what it would do and stops.

---

## The shape: one run per file, not one run for the sweep

The instinct is a single "sweep" run with fifty work orders in it. That is the
wrong decomposition, and it fights the engine: a workflow's rules are checked
by enumerating every reachable path over a **finite declared domain**, and
"fifty, but sometimes eleven" is not one.

So each file is its own run of a two-step workflow — change it, then test it —
and the sweep is fifty of those. This gets three things for free:

- `workflow_next` already spans every run in a crew, so all fifty outstanding
  files are on offer at once and any number of agents can drain them.
- **The run's identity is the file path.** Two runs for one file are not
  prevented by care; they are not representable.
- Restarting tomorrow re-attaches to the runs that exist instead of starting a
  second sweep, because `workflow_start` is idempotent on that identity.

## What the workflow guarantees

[`workflows/codemod-target/`](workflows/codemod-target) is five files: a
contract, a SAM machine, an effect mapper, a manifest, and the rules. The rules
are the interesting part:

| rule | what it stops |
|---|---|
| `at-most-one-edit-per-file` | two agents editing one file — the failure mode of a shared sweep |
| `at-most-one-verification-per-file` | paying for the same test run twice |
| `verification-implies-a-prior-edit` | calling something verified when nothing was changed |
| `nothing-is-verified-after-a-skip` | running a suite for a file nobody touched |
| `exactly-one-edit-when-started` | a queued file silently doing nothing |

At boot, polyflow enumerates every reachable emission path and either admits
the workflow or refuses to register it:

```
[polycrew] admitted: codemod-target — paths explored: 4 · states seen: 7 · exhaustive within declared domains
```

The distinction that matters: the worker prompt *asks* agents not to touch
unclaimed files. The rules make a second edit order for one file something the
engine will not emit. A prompt is a request; this is a gate.

---

## What the script does, step by step

**1. Candidates.** `git grep -l` for `--match`. A literal search, deliberately
dumb and deliberately auditable — it over-matches, and the next step is where
that gets fixed. Capped by `--limit`.

**2. Safety.** Refuses to run on a dirty tree, because a sweep is much easier
to read as a diff against a clean one. Creates a branch. Adds its own working
directory to `.git/info/exclude` rather than editing your `.gitignore`.

**3. A broker that outlives the agents.** One process whose only job is to hold
the crew's port and its parked work orders for the whole sweep. The reason is
the most useful thing in this example — see
[below](#the-bug-this-example-was-built-on).

**4. Planner.** One headless agent reads the candidates and decides which
genuinely need the change, calling `workflow_start` once per file. This is the
judgement step, which is why a model does it. In the run below it correctly
rejected two of four candidates:

```
Rejected:
- packages/gamma/src/notes.js — only a comment mentioning moment( ); the code
  uses Intl.DateTimeFormat, no moment import.
- scripts/check.mjs — the sweep's own verification script; moment( appears only
  in a comment and a string literal used to detect leftover calls. Changing it
  would break the checker.
```

It has no `Edit` tool. A file it changed would be changed again by whoever
claims it.

**5. Workers.** `--workers` headless agents, started together, each running:

```
workflow_next  → what is free
workflow_claim → take one; if claimed:false, take a different one, never retry
   …read, edit, or run the test command…
workflow_report→ record it, and get whatever comes next
```

**6. Summary.** Read back from the crew's store, not from what the agents said
about themselves:

```
    packages/alpha/src/date.js   changed + verified
                                 by claude-code/0532d096
    packages/beta/src/report.js  changed + verified
                                 by claude-code/ae9169ad
    packages/gamma/src/notes.js  not selected  (the planner did not queue this file)
    scripts/check.mjs            not selected  (the planner did not queue this file)

    4 candidate(s): 2 done, 2 not selected
    2 agent(s) did the work, and no file was edited twice
```

**7. The diff**, plus how to review it and how to throw it away.

---

## The bug this example was built on

The first working version of this script failed in a way worth keeping.

Both workers claimed different files, edited them correctly, ran the tests —
and then **every single report came back `order-expired`**. The changes were on
disk with nothing in the sweep's record to say who made them or that they had
been verified.

One of the agents diagnosed it in its own final summary:

> the claim TTL appears short enough that a read + three edits + one report call
> overran it. Renewing the claim just before reporting would avoid this.

That was wrong, and it is a good example of a plausible explanation for the
wrong reason. The claim lease was fifteen minutes.

The actual cause: **every `claude -p` invocation spawns its own polycrew
process**, and the first to start becomes the broker. A work order's row lives
in SQLite and survives anything — which is why the workers could still *see*
and *claim* their files — but the parked handler the engine is waiting on lives
in the broker's **memory**. The planner was the broker. When the planner exited,
those handlers went with it, and the workers' reports arrived somewhere with
nothing left to report to.

### What was fixed because of it

Losing a completed piece of work is the exact failure this whole design exists
to prevent — the order would later be re-offered and somebody would do it
again. So polycrew no longer refuses that report. **A result reported when no
handler is parked is written down instead**, on the order row, and the next
time the engine offers that order it settles from the stored result and never
asks anyone to repeat the work. A second report of an already-recorded order is
refused with `already-reported` rather than overwriting the first, and a
recorded order is not offered to anyone in the meantime.

So the edits those two workers made would survive today. Their reports come
back with a note instead of an error:

    recorded — the broker that was waiting for this is gone, so the run takes
    it up when the engine next offers the order. Do not do this work again.

### Why the sweep still starts a broker

Because *recorded* is not *delivered*. A stored result reaches the run only
when polyrun's effect lease lapses and the order comes back — five minutes by
default, tunable with `POLYCREW_EFFECT_LEASE_MS`. A sweep that finishes in
ninety seconds would end with every file changed on disk and every run still
showing as in progress.

The durable report is the safety net. The long-lived broker is the design.

**The general lesson for anyone building on polycrew: if your participants come
and go, give the crew a broker that does not.** A crew of long-running
interactive sessions does not need this, because one of them is always the
broker. A crew of short headless ones does.

---

## Options

| flag | | |
|---|---|---|
| `--repo` | required | the monorepo to sweep |
| `--change` | required | what to do to each file, in a sentence the agents read |
| `--match` | required | a literal string that finds candidates |
| `--test-cmd` | required | how to test one file; the path is appended |
| `--glob` | | narrow the search, e.g. `'packages/**/*.ts'` |
| `--workers` | `2` | how many agents drain the sweep |
| `--limit` | `10` | cap on candidates — raise it once you trust a sweep |
| `--yes` | | actually run; without it you get the plan and nothing else |

**Start small.** `--limit 3 --workers 2` on a repo you can throw away tells you
whether your `--change` sentence is clear enough long before it tells you
anything about polycrew.

## Watching it

While it runs, the broker serves a page — the URL is in
`.polycrew-sweep/broker.log`:

```
[polycrew] broker on :41352 · dashboard http://127.0.0.1:41352/dashboard
```

Open it to see which files are claimed, by whom, and how long each has been
held.

Everything the sweep produced is left in `<repo>/.polycrew-sweep/`: the crew's
store, the generated MCP config, the exact prompts rendered for the run, and a
log per agent. It is excluded from git, and safe to delete.

## Honest limits

- **It edits your code.** It refuses to start on a dirty tree and works on a
  branch, but review the diff. That is what step 7 is for.
- **The test command is trusted.** Workers may run exactly that one command, and
  they are told not to run anything else — but "told" is a prompt, not a gate.
  Do not point it at something that deploys.
- **A failing verify is recorded, not fixed.** That is deliberate: a sweep that
  quietly repairs its own failures is a sweep whose diff you cannot trust.
- **Windows, macOS and Linux.** Git Bash hands out `/c/Users/...` paths that
  Windows `node` cannot open, so the script converts them with `cygpath -m`;
  elsewhere that is a no-op. This was the second bug found while building it.
- **A sweep of any size takes a while.** These are real agents reading real
  files. Ten files with three workers is minutes, not seconds.
