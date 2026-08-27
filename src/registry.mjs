// Who is running, and where to find them.
//
// The spec called for one `instances.json`. A single file is the wrong shape:
// every session would read-modify-write it, and two starting at once lose an
// entry with no error anywhere. So the registry is a DIRECTORY and each
// process owns exactly one file in it — nobody writes anyone else's, so there
// is nothing to lose. Listing is a readdir; reaping is deleting the files
// whose process is gone.
//
//   ~/.polyflow/registry/<area>/<actor>.json      (POLYCREW_HOME overrides ~/.polyflow)

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** A file-safe form of an area name; areas are already conservative (areas.mjs). */
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';

export function home() {
  return process.env.POLYCREW_HOME
    ? resolve(process.env.POLYCREW_HOME)
    : join(homedir(), '.polyflow');
}

export const registryDir = (area) =>
  (area ? join(home(), 'registry', slug(area)) : join(home(), 'registry'));

/**
 * An actor id the process mints for itself: `{agent}/{8 hex}`.
 * Never supplied by a caller, so two sessions cannot collide and one cannot
 * rename itself into a second identity (spec MA-1).
 */
export const mintActor = (agent) => `${agent}/${randomBytes(4).toString('hex')}`;

/** FNV-1a over the crew name — chosen for stability across versions, not spread. */
function hash(area) {
  let h = 0x811c9dc5;
  for (const ch of String(area)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const BASE = 41_000;
const SPAN = 8_000;
// Coprime with SPAN, so stepping by it visits distinct ports rather than
// cycling early. It also spreads them across the whole range, which matters:
// this machine refuses a contiguous 4,000-port block with nothing listening on
// it (Windows reserves ranges for Hyper-V that `netsh excludedportrange` does
// not always show), and consecutive candidates would all land inside it.
const STEP = 1_009;

/**
 * The ports a crew's broker will try, in order. Derived from the crew name, so
 * every session of that crew agrees on where to look, and the same crew is the
 * same URL every day.
 */
export function portsFor(area, count = 24) {
  const h = hash(area);
  return Array.from({ length: count }, (_, i) => BASE + ((h + i * STEP) % SPAN));
}

/** The port a crew prefers — the first candidate. */
export const portFor = (area) => portsFor(area, 1)[0];

/** Is that process still there? EPERM means alive but not ours, which is alive. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const fileFor = (area, actor) => join(registryDir(area), `${slug(actor)}.json`);

/** Write this process's own entry. Nobody else writes this file. */
export function register({ area, agent, actor, roles = [], store, workflows, port, pid = process.pid }) {
  const entry = {
    area, agent, actor, roles, store, workflows,
    port: port ?? portFor(area),
    pid,
    startedAt: new Date().toISOString(),
  };
  const dir = registryDir(area);
  mkdirSync(dir, { recursive: true });
  const target = fileFor(area, actor);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf-8');
  renameSync(tmp, target);
  return entry;
}

/** Live entries for one area, or for every area. Dead ones are deleted as we go. */
export function entries(area) {
  const dirs = area
    ? [registryDir(area)]
    : (existsSync(registryDir()) ? readdirSync(registryDir()).map((d) => join(registryDir(), d)) : []);

  const live = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      let entry;
      try {
        entry = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        // A torn or hand-edited file is not evidence of a live session.
        rmSync(path, { force: true });
        continue;
      }
      if (alive(entry.pid)) live.push(entry);
      else rmSync(path, { force: true });
    }
  }
  return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Remove this process's entry. Idempotent, and safe to call on a signal. */
export function unregister(area, actor) {
  rmSync(fileFor(area, actor), { force: true });
}
