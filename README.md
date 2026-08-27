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

> Early. C0, the MVP, is complete and its acceptance run is in
> [`FINDINGS-step8.md`](FINDINGS-step8.md). The checks it inherits are
> **consistency checks, not proofs**, and "exhaustive" means exhaustive over
> the finite domain a workflow declares. There is **no authentication**: see
> [What this does not do](#what-this-does-not-do).

---

## Getting started

### 1. Install

```bash
git clone https://github.com/cognitive-fab/polycrew
cd polycrew
npm install
npm test          # 59 tests, no model, no network
```

Node 22.13+ is required (it uses `node:sqlite`).

### 2. Point a session at it

polycrew is an MCP stdio server. In the project you want a crew for, create
`.mcp.json`:

```json
{
  "mcpServers": {
    "polycrew": {
      "command": "node",
      "args": ["--no-warnings", "/absolute/path/to/polycrew/bin/polycrew.mjs"],
      "env": {
        "POLYCREW_INSTANCE": "my-project"
      }
    }
  }
}
```

Then start Claude Code in that directory. Everything else has a default: the
run store lands in `.polycrew/`, the workflow library falls back to the demo
one polyflow ships, and the broker port is derived.

### 3. Start the crew

Open **two** terminals in the same project and run `claude` in each. On boot
the servers print what they are:

```
[polycrew] broker on :43617 · dashboard http://127.0.0.1:43617/dashboard
[polycrew] actor polycrew/8c6f1db6 · crew my-project · broker :43617 · 1 session
[polycrew] admitted: customer-brief — paths explored: 5 · states seen: 10 · exhaustive within declared domains
```

```
[polycrew] proxy to :43617
[polycrew] actor polycrew/82b4feb2 · crew my-project · proxy :43617 · 2 sessions
```

**Whichever session starts first is the broker.** Binding the port *is* the
election — the operating system hands it to exactly one process, so there is no
consensus protocol, nothing to install and nothing to configure. The rest
forward their tool calls to it over loopback. If the broker dies, the next call
from any session elects a new one on the same port, and the runs continue out
of the same store.

### 4. Do some work

Ask either session to run a workflow. The interesting part is asking **both**:

> Start the customer-brief workflow for today, then keep taking work with
> workflow_next until there is none left.

Each session asks what is free, claims one, does it, reports it. Nobody assigns
anything. No order is done twice.

---

## The loop an agent runs

Eight tools. Six come from polyflow unchanged; `workflow_next` and
`workflow_claim` are what a crew adds.

| tool | | what it is for |
|---|---|---|
| `workflow_list` | read | what this crew can run, and the rules each was admitted under |
| `workflow_start` | write | begin a run, or re-attach to the one this input already names |
| `workflow_next` | read | **open orders you may take**, across every run in the crew |
| `workflow_claim` | write | **take one, so nobody else starts the same work** |
| `workflow_report` | write | report a result and get the next order |
| `workflow_state` | read | one run as it stands, with every order and its holder |
| `workflow_journal` | read | every step, who caused it, and why one was refused |
| `workflow_signal` | write | an event that did not come from an order |

The shape of a turn:

```
workflow_next  {}                       → 3 orders, none claimed
workflow_claim { order_id: "a1b2…" }    → claimed: true, claimed_until: …
   …do the work with your own tools, under your own permissions…
workflow_report{ order_id: "a1b2…", result: { count: 7 } }
                                        → the run advanced; here is what is next
```

Two rules a model has to follow, and both are carried by the tools themselves
rather than by a prompt:

**Take work from `workflow_next`, never from `workflow_state`.** `workflow_state`
shows the whole run, including orders that belong to someone else.
`workflow_next` shows only what is free and only what your roles allow.

**A refused claim is an answer, not an error.** `claimed: false` comes back with
who holds it and a hint to call `workflow_next` for something else. This is
deliberate: a model that receives an error retries the call it just made, and a
model that receives an answer goes and finds other work. Both live sessions in
the acceptance run got this right on the first attempt.

### Claims are leases

A claim holds while you work and lapses on silence — `POLYCREW_LEASE_MS`,
five minutes by default. Re-claiming an order you already hold renews it, so a
long job is held by working on it rather than by a separate keep-alive. If a
session dies mid-order, its claim expires and the order returns to the offer
list at a higher attempt. **Only the holder may report.** A report from anyone
else is refused with `not-your-order` and the run does not move.

---

## The dashboard

Every broker serves one, read-only, on the port it already holds:

```
http://127.0.0.1:<port>/dashboard        the page
http://127.0.0.1:<port>/dashboard.json   the same facts, for scripts
```

It answers two questions in order — **what needs a person** (orders addressed
to a human role that nobody has taken, longest wait first) and **what is
running** (state, who holds each order, and what the machine is waiting for and
until when). The boot line prints the URL so you do not have to work out the
port.

It is loopback-only and read-only, and both are enforced rather than assumed:
any method but GET is refused, a non-loopback caller is refused, and polycrew
will not bind a non-loopback interface at all.

---

## Writing a workflow

A workflow is a directory of five files: a contract, a SAM v2 machine, an
effect mapper, an effect manifest, and the rules it must satisfy. Point
`POLYCREW_WORKFLOWS` at the directory that contains them.

The two worth reading are
[`customer-brief`](https://github.com/cognitive-fab/polyflow/tree/main/workflows/customer-brief)
— sequential, with a human approval gate and a timer — and
[`release-check`](test/fixtures/workflows/release-check), which emits **three
work orders in one step** and publishes only if all three pass. The second is
the shape a crew is actually for.

**A workflow that fails its rules is not registered.** Startup enumerates every
reachable emission path over the domain the contract declares; if a rule can be
broken on any of them, the workflow cannot be started at all, and the boot log
says which rule and on which path. `release-check` is admitted at 243 paths
explored. This is the one thing to understand before writing one: the rules are
not documentation and not a lint pass — they are the gate.

Full detail, including the descriptor format and key policies, is in the
[polyflow README](https://github.com/cognitive-fab/polyflow#a-workflow).

---

## Settings

Everything is an environment variable, read once at boot.

| env | meaning | default |
|---|---|---|
| `POLYCREW_WORKFLOWS` | workflow library | `./workflows`, else the demo library polyflow ships |
| `POLYCREW_DB` | run store | `.polycrew/polycrew.sqlite` |
| `POLYCREW_ORDERS` | order store | beside the run store |
| `POLYCREW_INSTANCE` | instance area — **one crew** | the current directory's name |
| `POLYCREW_AGENT` | agent-class area | `polycrew` |
| `POLYCREW_ROLES` | roles this session may play, comma-separated | none |
| `POLYCREW_LEASE_MS` | how long a claim holds without renewal | `300000` (5 min) |
| `POLYCREW_PORT` | broker port | derived from the crew |
| `POLYCREW_HOME` | where the registry lives | `~/.polyflow` |

**Identity and roles come from the process, never from a tool argument.** No
tool schema has a field for an actor or a role. A session that could name
itself could collide with another or invent a second self; a session that could
declare its own roles could attach as a reviewer and satisfy its own approval
gate. Anything a model can say, a model can say wrongly.

### Several crews on one machine

A crew is a **name and a store**, not a name. Two projects both called `app`
with separate `.polycrew/` directories are two crews with two brokers, and
neither can see the other's work. Sessions join a crew only when the broker
answering a port says it is theirs.

To put two crews in one directory, give them different `POLYCREW_INSTANCE`
values and different `POLYCREW_DB` paths.

---

## What this does not do

**There is no authentication.** None. The dashboard asks nobody who they are,
and the broker's RPC endpoint accepts any loopback caller. On loopback that is
the same trust as a shell on the machine, which is the whole security model.
To reach a crew from another machine, use an SSH tunnel — do not bind a public
interface, and polycrew will refuse to anyway.

**polycrew never executes anything.** It has no credentials and no connectors.
An effect becomes a *work order* handed back to an agent, which runs the tool
under its own permissions and reports the result. Nothing about a claim grants
permission to do anything.

**Not built yet:** a progress view over a run tree, a rendered run report, host
wake events, child workflows and cross-workflow cancellation, and `actor` /
`order_id` columns on polyrun's own journal (C0 keeps attribution in polycrew's
store instead and joins it on read).

---

## Troubleshooting

**Every session says `proxy to :NNNNN` and then calls fail.** An older build
read "a bind failed" as "a broker is here". Current builds treat a port as
taken only when something *answers* on it. If you still see this, the crew's
whole candidate range may be unusable — see below.

**`no usable port for this crew`.** Windows reserves large port ranges for
Hyper-V and WSL, and a bind there fails with nothing listening. One machine
here refuses a contiguous 4,000-port block that
`netsh interface ipv4 show excludedportrange protocol=tcp` does not list.
Candidates step across the whole range to avoid this; if it still happens, set
`POLYCREW_PORT` to something you know is free.

**A session appears in the registry after it died.** It does not: entries are
reaped on read, by checking the pid. `~/.polyflow/registry/<crew>/` is safe to
delete while nothing is running.

**A workflow does not appear in `workflow_list`.** It was refused by the
admission gate, or its directory name disagrees with the `name` in its
descriptor. Either way the boot log says so, on stderr.

---

## How it is put together

| file | what it holds |
|---|---|
| `bin/polycrew.mjs` | boot: read the environment, mint an actor, elect or proxy, serve stdio |
| `src/link.mjs` | the election — bind, identify, forward, take over |
| `src/node.mjs` | one session: broker or proxy, and able to change its mind |
| `src/store-broker.mjs` | orders in SQLite; claims, leases, offers |
| `src/crew-tools.mjs` | `workflow_next` and `workflow_claim` |
| `src/attribution.mjs` | who caused each step, joined onto the journal on read |
| `src/dashboard.mjs` | the page and the JSON behind it |
| `src/registry.mjs` | who is running, and where to find them |

### Why it is a separate package

The fork is not one agent versus many. It is *in-process broker, stdio,
SQLite* versus *a broker several processes share*. Everything else in the
design scales down to one participant for free, so polyflow keeps it.

polycrew supplies two of polyflow's exports — a store-backed broker, and extra
tools — and uses `Library` and `Polyflow` as they are. It never forks the
admission gate: two gates would mean the guarantee stops being one sentence.

Full design: the polycrew specification and the C0 plan in the
[polyflow repository](https://github.com/cognitive-fab/polyflow/tree/main/docs).

## Status

C0 is complete — the seam, the scaffold, identity and the registry, the order
store, election and proxy, the crew tools, actor attribution, the dashboard,
and acceptance. 59 tests.

The measurement it was built to pass, and does: two CLI sessions in one project
on a run with several open orders — one completion per order, two actor ids
neither session chose, and after killing one mid-order its claim expires and
the other takes it. The live run with two real `claude` sessions is written up
in [`FINDINGS-step8.md`](FINDINGS-step8.md), including what it does *not* show.
