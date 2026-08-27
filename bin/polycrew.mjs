#!/usr/bin/env node
// polycrew — several agents, and the people among them, working one run.
//
// C0 step 1: this is polyflow's single-agent server, reached through the
// package boundary rather than reimplemented. Election, claims, the crew tools
// and the dashboard arrive in the steps after this one; what this file proves
// is that the dependency direction holds and nothing had to be forked to get
// here. See docs/polycrew-c0-plan.md in the polyflow repo.
//
//   POLYCREW_WORKFLOWS  workflow library      (default ./workflows, else the
//                                              demo library polyflow ships)
//   POLYCREW_DB         run store             (default .polycrew/polycrew.sqlite)
//   POLYCREW_AGENT      agent-class area      (default 'polycrew')
//   POLYCREW_INSTANCE   instance area         (default cwd basename)
//   POLYCREW_ROLES      roles this actor may play — read at boot, never a tool
//                       argument (spec MA-3). Unused until step 5.
//   POLYCREW_HOME       registry location     (default ~/.polyflow)

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Polyflow, makeTools, serve } from 'polyflow';

import { entries, mintActor, portFor, register, unregister } from '../src/registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

/** Where polyflow was installed — its bundled demo library lives beside its code. */
function polyflowRoot() {
  const entry = createRequire(import.meta.url).resolve('polyflow');
  return resolve(dirname(entry), '..');
}

function workflowsDir() {
  if (process.env.POLYCREW_WORKFLOWS) return resolve(process.env.POLYCREW_WORKFLOWS);
  const local = resolve(process.cwd(), 'workflows');
  if (existsSync(local)) return local;
  return join(polyflowRoot(), 'workflows');
}

// Read at boot, never accepted as a tool argument: a session that could declare
// its own roles could attach as a reviewer and satisfy its own approval gate.
const roles = (process.env.POLYCREW_ROLES ?? '')
  .split(',').map((r) => r.trim()).filter(Boolean);

const agent = process.env.POLYCREW_AGENT ?? 'polycrew';
const area = process.env.POLYCREW_INSTANCE ?? basename(process.cwd());
const store = process.env.POLYCREW_DB ?? resolve('.polycrew', 'polycrew.sqlite');
const workflows = workflowsDir();

// Minted here, never accepted from a caller (spec MA-1). One process is one
// session, so the process is the right thing to name.
const actor = mintActor(agent);

const pf = new Polyflow({ workflowsDir: workflows, dbPath: store, agent, instance: area });

await pf.start();

register({ area, agent, actor, roles, store, workflows });
const crew = entries(area);
console.error(`[polycrew] actor ${actor} · crew ${area} · port ${portFor(area)} · ${crew.length} session${crew.length === 1 ? '' : 's'}`);

for (const [name, cert] of pf.certificates) {
  console.error(`[polycrew] ${cert.ok ? 'admitted' : 'REFUSED'}: ${name} — ${cert.report.split('\n')[0]}`);
  if (!cert.ok) for (const v of cert.violations) console.error(`[polycrew]   ${v.name ?? v}`);
}
if (roles.length) console.error(`[polycrew] roles: ${roles.join(', ')}`);

serve({ name: 'polycrew', version: VERSION, tools: makeTools(pf) });

const bye = async () => {
  unregister(area, actor);
  await pf.close();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
