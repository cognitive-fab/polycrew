# polycrew

**Several agents — and the people among them — working one run at the same
time.** Coordination is a journaled step of a machine that was checked before
it loaded. Agents never talk to each other; they talk to the run.

polycrew is the multi-participant layer over
[polyflow](https://github.com/cognitive-fab/polyflow), which it uses as a
library. polyflow stays the single-participant engine: one process, one broker
in memory, stdio, SQLite, nothing to install. polycrew is what changes when
there is more than one participant — a broker they share, orders one of them
can claim, and a page a person can watch.

> Early. C0 (the MVP) is under construction; the steps below say where it is.
> The checks it inherits are **consistency checks, not proofs**, and
> "exhaustive" means exhaustive over the finite domain a workflow declares.

## Why it is a separate package

The fork is not one agent versus many. It is *in-process broker, stdio,
SQLite* versus *a broker several processes share*. Everything else in the
design scales down to one participant for free, so polyflow keeps it.

polycrew supplies two of polyflow's four exports — a store-backed broker, and
extra tools — and uses `Library` and `Polyflow` as they are. It never forks the
admission gate: two gates would mean the guarantee stops being one sentence.

Full design: the polycrew specification and the C0 plan in the
[polyflow repository](https://github.com/cognitive-fab/polyflow/tree/main/docs).

## Run it

```bash
npm install
npm test
node bin/polycrew.mjs      # an MCP stdio server
```

| env | meaning | default |
|---|---|---|
| `POLYCREW_WORKFLOWS` | workflow library | `./workflows`, else the demo library polyflow ships |
| `POLYCREW_DB` | run store | `.polycrew/polycrew.sqlite` |
| `POLYCREW_AGENT` | agent-class area | `polycrew` |
| `POLYCREW_INSTANCE` | instance area — one crew | the current directory's name |
| `POLYCREW_ROLES` | roles this session may play | none |
| `POLYCREW_HOME` | where the registry lives | `~/.polyflow` |
| `POLYCREW_ORDERS` | order store | beside the run store |

**Identity and roles come from the process, never from a tool argument.** A
session that could name itself could collide with another, and one that could
declare its own roles could attach as a reviewer and satisfy its own approval
gate. Anything a model can say, a model can say wrongly.

## Where C0 is

- [x] **1 — scaffold.** polyflow as a pinned dependency; the six tools served
      through it; roles read from the environment.
- [x] **2 — identity and the registry.** Actor ids minted per process; a
      registry under `~/.polyflow/registry/<crew>/<actor>.json`, one file per
      session, reaped when the process is gone. The port a crew's broker will
      bind is derived from its name.
- [x] **3 — the order store and a claiming broker.** Orders live in a table,
      not one process's memory. A claim is a lease: it holds while the actor
      works, lapses on silence, and only the holder may report. An order
      with no role stays open to anyone, which is how a single-participant
      run keeps working unchanged.
- [ ] 4 — election and proxy: the first process on a crew binds its port and
      becomes the broker; the rest proxy to it
- [ ] 5 — the crew tools: `workflow_next`, `workflow_claim`
- [ ] 6 — actor attribution in the journal
- [ ] 7 — the dashboard, read-only
- [ ] 8 — acceptance: two `claude` sessions, one run

The measurement C0 is built to pass: two CLI sessions in one project on a run
with several open orders — one completion per order, two actor ids neither
session chose, and after killing one mid-order its claim expires and the other
takes it.
