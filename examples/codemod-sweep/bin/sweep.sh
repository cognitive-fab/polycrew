#!/usr/bin/env bash
# A codemod sweep across a monorepo, run by a crew of headless Claude Code
# agents that share the work through polycrew.
#
# Nothing here assigns work. The script finds candidate files and starts one
# run per file; the agents then ask what is free, claim one, change it, and run
# its tests. Two agents cannot take the same file, no file is edited twice, and
# a file whose tests never ran is never called done — those are the workflow's
# admitted rules, not this script's good intentions.
#
#   ./sweep.sh --repo ../my-monorepo \
#              --change "replace moment() with dayjs()" \
#              --match "moment(" \
#              --test-cmd "npm test --" \
#              --workers 3 --limit 10 --yes
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/.." && pwd)"
POLYCREW="$(cd "$EXAMPLE/../.." && pwd)"

REPO="" CHANGE="" MATCH="" TEST_CMD="" WORKERS=2 LIMIT=10 GLOB="" YES=0 KEEP=0

die() { printf '\n%s\n' "$*" >&2; exit 1; }
# Git Bash hands out POSIX paths (/c/Users/...) that Windows node cannot open,
# and the MCP config is read by node, not by the shell. `cygpath -m` converts to
# the mixed form (C:/Users/...) that both understand. Everywhere else this is a
# no-op: there is no cygpath, and the path was already native.
if command -v cygpath >/dev/null 2>&1; then
  native() { cygpath -m "$1"; }
else
  native() { printf '%s' "$1"; }
fi

say() { printf '%s\n' "$*"; }
rule() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)      REPO="${2:-}"; shift 2 ;;
    --change)    CHANGE="${2:-}"; shift 2 ;;
    --match)     MATCH="${2:-}"; shift 2 ;;
    --glob)      GLOB="${2:-}"; shift 2 ;;
    --test-cmd)  TEST_CMD="${2:-}"; shift 2 ;;
    --workers)   WORKERS="${2:-}"; shift 2 ;;
    --limit)     LIMIT="${2:-}"; shift 2 ;;
    --yes)       YES=1; shift ;;
    --keep)      KEEP=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *)           die "unknown option: $1" ;;
  esac
done

[ -n "$REPO" ]     || die "--repo is required"
[ -n "$CHANGE" ]   || die "--change is required (what the sweep should do to each file)"
[ -n "$MATCH" ]    || die "--match is required (a literal string that finds candidate files)"
[ -n "$TEST_CMD" ] || die "--test-cmd is required (how to test one file, e.g. 'npm test --')"
command -v claude >/dev/null || die "the 'claude' CLI is not on PATH"
command -v node   >/dev/null || die "node is not on PATH"

REPO="$(cd "$REPO" 2>/dev/null && pwd)" || die "no such directory: $REPO"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git repository"

SLUG="$(printf '%s' "$CHANGE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/-*$//')"
BRANCH="codemod-sweep/$SLUG"
WORK="$REPO/.polycrew-sweep"
CREW="sweep-$SLUG"

# The sweep's own working directory lives in the repo so it is easy to find,
# and is excluded BEFORE the cleanliness check below — otherwise a dry run
# leaves it behind and the real run refuses to start because of it.
mkdir -p "$WORK"
grep -qxF '.polycrew-sweep/' "$REPO/.git/info/exclude" 2>/dev/null \n  || echo '.polycrew-sweep/' >> "$REPO/.git/info/exclude"

# ---------------------------------------------------------------- safety ----
# This edits files. It refuses to start anywhere the change would be hard to
# undo or hard to see: a dirty tree hides what the sweep did in what was
# already there.
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  die "$REPO has uncommitted changes. Commit or stash them first — a sweep is
much easier to read as a diff against a clean tree."
fi

# ------------------------------------------------------------ candidates ----
rule "1. Candidates"
say "Searching $REPO for: $MATCH"
if [ -n "$GLOB" ]; then
  git -C "$REPO" grep -l --fixed-strings -- "$MATCH" -- "$GLOB" > "$WORK/candidates.txt" 2>/dev/null || true
else
  git -C "$REPO" grep -l --fixed-strings -- "$MATCH" > "$WORK/candidates.txt" 2>/dev/null || true
fi
# Keep only paths the run key accepts: the file path IS the run's identity.
grep -E '^[A-Za-z0-9._/-]+$' "$WORK/candidates.txt" > "$WORK/targets.txt" || true
head -n "$LIMIT" "$WORK/targets.txt" > "$WORK/targets.head" && mv "$WORK/targets.head" "$WORK/targets.txt"

COUNT=$(wc -l < "$WORK/targets.txt" | tr -d ' ')
[ "$COUNT" -gt 0 ] || die "nothing matched '$MATCH' in $REPO — nothing to sweep"
say "$COUNT file(s), capped at --limit $LIMIT:"
sed 's/^/    /' "$WORK/targets.txt"

# ------------------------------------------------------------------ plan ----
rule "2. What will happen"
cat <<PLAN
    repository   $REPO
    branch       $BRANCH        (created; your current branch is left alone)
    change       $CHANGE
    tests        $TEST_CMD <file>
    crew         $CREW
    agents       1 planner, then $WORKERS worker(s), all headless

    Each file becomes its own run. Agents claim files one at a time; no file
    is edited twice and no change is called done without its tests running.
PLAN

if [ "$YES" -ne 1 ]; then
  printf '\nRe-run with --yes to go ahead.\n'
  exit 0
fi

git -C "$REPO" checkout -q -B "$BRANCH" || die "could not create branch $BRANCH"

# --------------------------------------------------------------- the crew ---
N_POLYCREW="$(native "$POLYCREW")"
N_EXAMPLE="$(native "$EXAMPLE")"
N_WORK="$(native "$WORK")"

cat > "$WORK/mcp.json" <<MCP
{
  "mcpServers": {
    "polycrew": {
      "command": "node",
      "args": ["--no-warnings", "$N_POLYCREW/bin/polycrew.mjs"],
      "env": {
        "POLYCREW_WORKFLOWS": "$N_EXAMPLE/workflows",
        "POLYCREW_INSTANCE": "$CREW",
        "POLYCREW_DB": "$N_WORK/sweep.sqlite",
        "POLYCREW_HOME": "$N_WORK/registry",
        "POLYCREW_AGENT": "claude-code",
        "POLYCREW_LEASE_MS": "900000"
      }
    }
  }
}
MCP

# --------------------------------------------------- a broker that stays ---
# Started BEFORE any agent, and killed only after the last one. Without it the
# planner's own process is the broker, it dies when the planner exits, and
# every worker's report comes back order-expired against an order it really
# does hold. See bin/broker.mjs for why.
rule "3. Broker"
POLYCREW_WORKFLOWS="$N_EXAMPLE/workflows" POLYCREW_INSTANCE="$CREW" POLYCREW_DB="$N_WORK/sweep.sqlite" POLYCREW_HOME="$N_WORK/registry" POLYCREW_AGENT="claude-code" POLYCREW_LEASE_MS="900000"   node --no-warnings "$(native "$HERE")/broker.mjs" 2>"$WORK/broker.log" &
BROKER_PID=$!
trap 'kill "$BROKER_PID" 2>/dev/null' EXIT

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  grep -q "broker on" "$WORK/broker.log" 2>/dev/null && break
  sleep 1
done
grep -q "broker on" "$WORK/broker.log" 2>/dev/null   || die "the broker did not come up — see $WORK/broker.log"
sed 's/^/    /' "$WORK/broker.log"

TOOLS_PLAN="mcp__polycrew__workflow_list mcp__polycrew__workflow_start mcp__polycrew__workflow_state Read Grep Glob"
TOOLS_WORK="mcp__polycrew__workflow_next mcp__polycrew__workflow_claim mcp__polycrew__workflow_report mcp__polycrew__workflow_state Read Edit Grep Glob Bash"

render() {  # substitute the sweep's parameters into a prompt template
  sed -e "s|{{CHANGE}}|$CHANGE|g" -e "s|{{TEST_CMD}}|$TEST_CMD|g" -e "s|{{MATCH}}|$MATCH|g" "$1"
}

# ------------------------------------------------------------- 3. planner ---
rule "4. Planner — deciding which candidates really need the change"
render "$EXAMPLE/prompts/planner.md" > "$WORK/planner.prompt"
cat "$WORK/targets.txt" >> "$WORK/planner.prompt"

( cd "$REPO" && timeout 900 claude -p "$(cat "$WORK/planner.prompt")" \
    --mcp-config "$WORK/mcp.json" --allowedTools $TOOLS_PLAN --max-turns 80 ) \
  > "$WORK/planner.log" 2>"$WORK/planner.err"
tail -n 12 "$WORK/planner.log" | sed 's/^/    /'

# ------------------------------------------------------------- 4. workers ---
rule "5. Workers — $WORKERS agent(s) draining the sweep"
render "$EXAMPLE/prompts/worker.md" > "$WORK/worker.prompt"

for i in $(seq 1 "$WORKERS"); do
  ( cd "$REPO" && timeout 1800 claude -p "$(cat "$WORK/worker.prompt")" \
      --mcp-config "$WORK/mcp.json" --allowedTools $TOOLS_WORK --max-turns 200 ) \
    > "$WORK/worker-$i.log" 2>"$WORK/worker-$i.err" &
done
wait
for i in $(seq 1 "$WORKERS"); do
  say "  --- worker $i ---"
  tail -n 6 "$WORK/worker-$i.log" | sed 's/^/    /'
done

# ------------------------------------------------------------- 5. summary ---
kill "$BROKER_PID" 2>/dev/null; wait "$BROKER_PID" 2>/dev/null

rule "6. What the crew actually did"
POLYCREW_ROOT="$N_POLYCREW" EXAMPLE_ROOT="$N_EXAMPLE" SWEEP_WORK="$N_WORK" SWEEP_CREW="$CREW" \
  node --no-warnings "$(native "$HERE")/summary.mjs" "$N_WORK/targets.txt"

rule "7. The diff"
git -C "$REPO" --no-pager diff --stat "$BRANCH" | sed 's/^/    /'
say ""
say "Review it with:   git -C $REPO diff $BRANCH"
say "Undo everything:  git -C $REPO checkout - && git -C $REPO branch -D $BRANCH"
[ "$KEEP" -eq 1 ] || say "Logs and the crew's store are in $WORK"
