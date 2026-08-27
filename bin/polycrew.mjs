#!/usr/bin/env node
// polycrew — several agents, and the people among them, working one run.
//
// Every session runs this. Whoever binds the crew's port opens the store and
// becomes its broker; the rest forward their tool calls to it over loopback
// (spec MA-22). Nothing is installed and nothing is configured: the broker is
// whichever session started first.
//
//   POLYCREW_WORKFLOWS  workflow library      (default ./workflows, else the
//                                              demo library polyflow ships)
//   POLYCREW_DB         run store             (default .polycrew/polycrew.sqlite)
//   POLYCREW_ORDERS     order store           (default beside the run store)
//   POLYCREW_AGENT      agent-class area      (default 'polycrew')
//   POLYCREW_INSTANCE   instance area — one crew   (default cwd basename)
//   POLYCREW_ROLES      roles this actor may play — read at boot, never a tool
//                       argument (spec MA-3)
//   POLYCREW_PORT       broker port           (default derived from the crew name)
//   POLYCREW_HOME       registry location     (default ~/.polyflow)

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from 'polyflow';

import { CrewNode } from '../src/node.mjs';
import { entries, mintActor, portsFor, register, unregister } from '../src/registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

/** Where polyflow was installed — its bundled demo library lives beside its code. */
function polyflowRoot() {
  return resolve(dirname(createRequire(import.meta.url).resolve('polyflow')), '..');
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
const orders = process.env.POLYCREW_ORDERS ?? `${store.replace(/\.sqlite$/i, '')}.orders.sqlite`;
const workflows = workflowsDir();
const ports = Number(process.env.POLYCREW_PORT)
  ? [Number(process.env.POLYCREW_PORT)]
  : portsFor(area);

// Minted here, never accepted from a caller (spec MA-1). One process is one
// session, so the process is the right thing to name.
const actor = mintActor(agent);

const log = (msg) => console.error(`[polycrew] ${msg}`);

const node = new CrewNode({ area, agent, actor, roles, ports, store, orders, workflows, log });
await node.start();

register({ area, agent, actor, roles, store, workflows, port: node.port });
const crew = entries(area);
log(`actor ${actor} · crew ${area} · ${node.mode} :${node.port} · ${crew.length} session${crew.length === 1 ? '' : 's'}`);

// Only the broker loads the library, so only it has certificates to report.
for (const [name, cert] of node.pf?.certificates ?? []) {
  log(`${cert.ok ? 'admitted' : 'REFUSED'}: ${name} — ${cert.report.split('\n')[0]}`);
  if (!cert.ok) for (const v of cert.violations) log(`  ${v.name ?? v}`);
}
if (roles.length) log(`roles: ${roles.join(', ')}`);

serve({ name: 'polycrew', version: VERSION, tools: node.tools });

const bye = async () => {
  unregister(area, actor);
  await node.close();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
