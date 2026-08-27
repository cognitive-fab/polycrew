// What a person needs to see, on the port the broker already holds.
//
// Read-only and loopback-only. It answers two questions, in this order:
//
//   What needs me?   orders waiting on a human role, oldest first, with what
//                    they are asking and how long they have been asking it.
//   What is running? every run in flight, its state, who holds each order,
//                    and what the machine is waiting for.
//
// One function produces the facts and both surfaces render it, so the page and
// the JSON cannot drift: a person and a script are looking at the same thing.

import { isLoopback } from './link.mjs';

const HUMAN_ROLES = new Set(['human', 'reviewer', 'approver', 'operator']);

/** Everything the dashboard shows, as data. */
export async function snapshot({ pf, broker, area, actor, sessions = [], now = Date.now() }) {
  const runs = await pf.runs({ status: 'active' });

  const withOrders = await Promise.all(runs.map(async (r) => {
    // sweep: false — sweeping RELEASES lapsed claims, and a page that repaired
    // what it was reporting on could never show a lease going overdue, which
    // is the one thing a person watching a crew is watching for.
    const orders = broker.open(r.instanceId, { sweep: false }).map((o) => ({
      orderId: o.orderId,
      tool: o.tool,
      target: o.target ?? null,
      why: o.why,
      role: o.role ?? null,
      attempt: o.attempt,
      claimedBy: o.claimedBy ?? null,
      claimedUntil: o.claimedUntil ?? null,
      overdue: Boolean(o.claimedUntil && o.claimedUntil < now),
      waitingMs: now - (o.issuedAt ?? now),
    }));
    return { ...r, orders, timers: await pf.timers(r.instanceId) };
  }));

  const orders = withOrders.flatMap((r) => r.orders.map((o) => ({ ...o, instance: r.instanceId, workflow: r.workflow, key: r.key })));

  return {
    crew: area,
    broker: actor,
    at: now,
    sessions,
    runs: withOrders,
    needsAHuman: orders
      .filter((o) => o.role && HUMAN_ROLES.has(o.role) && !o.claimedBy)
      .sort((a, b) => b.waitingMs - a.waitingMs),
    unclaimed: orders.filter((o) => !o.claimedBy).length,
    overdue: orders.filter((o) => o.overdue),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "4m", "2h 10m", "just now" — a duration a person reads, not a number. */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const until = (at, now) => (at <= now ? 'overdue' : `in ${ago(at - now)}`);

function orderRow(o) {
  const who = o.claimedBy
    ? `<span class="who${o.overdue ? ' overdue' : ''}">${esc(o.claimedBy)}${o.overdue ? ' · lease overdue' : ''}</span>`
    : '<span class="free">unclaimed</span>';
  return `<tr>
    <td><code>${esc(o.tool)}</code>${o.target ? ` <span class="dim">→ ${esc(o.target)}</span>` : ''}</td>
    <td>${esc(o.why)}</td>
    <td>${o.role ? `<span class="role">${esc(o.role)}</span>` : '<span class="dim">anyone</span>'}</td>
    <td>${who}</td>
    <td class="num">${esc(ago(o.waitingMs))}</td>
  </tr>`;
}

function runCard(r, now) {
  const state = Object.entries(r.state ?? {})
    .map(([k, v]) => `<span class="kv"><b>${esc(k)}</b> ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`)
    .join('');
  const timers = r.timers.map((tm) =>
    `<li><code>${esc(tm.action)}</code> ${esc(until(tm.fireAt, now))} <span class="dim">(${esc(tm.key)})</span></li>`).join('');
  const orders = r.orders.length
    ? `<table><thead><tr><th>tool</th><th>why</th><th>role</th><th>held by</th><th>waiting</th></tr></thead>
       <tbody>${r.orders.map(orderRow).join('')}</tbody></table>`
    : `<p class="dim">No open orders${r.timers.length ? ' — waiting on a timer.' : '.'}</p>`;

  return `<section class="run">
    <h3>${esc(r.workflow)} <span class="key">${esc(r.key)}</span></h3>
    <div class="state">${state}</div>
    ${orders}
    ${timers ? `<ul class="timers">${timers}</ul>` : ''}
  </section>`;
}

/** The page. No scripts, no fonts, no requests — it renders wherever it is opened. */
export function page(s) {
  const needs = s.needsAHuman.length
    ? `<ul class="asks">${s.needsAHuman.map((o) => `<li>
        <b>${esc(o.why || o.tool)}</b>
        <span class="dim">${esc(o.workflow)} · ${esc(o.key)}</span>
        <span class="wait">waiting ${esc(ago(o.waitingMs))}</span>
      </li>`).join('')}</ul>`
    : '<p class="ok">Nothing is waiting on a person.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.crew)} · polycrew</title>
<style>
  :root { color-scheme: light dark; --fg:#16181d; --bg:#fbfbfa; --dim:#6b7280; --line:#e4e4e7;
          --card:#fff; --warn:#b45309; --ok:#15803d; --accent:#1d4ed8; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8ea; --bg:#141518; --dim:#9299a3; --line:#2a2c32; --card:#1b1d21;
            --warn:#f0a742; --ok:#4ade80; --accent:#8ab4ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .15rem; }
  h2 { font-size:1rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
       margin:2.25rem 0 .75rem; font-weight:600; }
  h3 { font-size:1rem; margin:0 0 .5rem; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.875em; }
  .sub { color:var(--dim); margin:0 0 .25rem; }
  .dim { color:var(--dim); }
  .key { color:var(--dim); font-weight:400; }
  .run { background:var(--card); border:1px solid var(--line); border-radius:10px;
         padding:1rem 1.1rem; margin-bottom:.9rem; }
  .state { display:flex; flex-wrap:wrap; gap:.4rem .9rem; margin-bottom:.75rem; }
  .kv { color:var(--dim); font-size:.875rem; } .kv b { color:var(--fg); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { text-align:left; font-weight:600; color:var(--dim); font-size:.78rem;
       text-transform:uppercase; letter-spacing:.05em; padding:.3rem .5rem .3rem 0; }
  td { padding:.35rem .5rem .35rem 0; border-top:1px solid var(--line); vertical-align:top; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; color:var(--dim); white-space:nowrap; }
  .free { color:var(--accent); } .who { font-family:ui-monospace,monospace; font-size:.85em; }
  .overdue { color:var(--warn); font-weight:600; }
  .role { border:1px solid var(--line); border-radius:99px; padding:.05rem .45rem; font-size:.8rem; }
  .asks { list-style:none; padding:0; margin:0; }
  .asks li { background:var(--card); border:1px solid var(--warn); border-left-width:3px;
             border-radius:8px; padding:.7rem .9rem; margin-bottom:.5rem;
             display:flex; gap:.75rem; align-items:baseline; flex-wrap:wrap; }
  .asks .wait { margin-left:auto; color:var(--warn); font-size:.875rem; white-space:nowrap; }
  .ok { color:var(--ok); }
  .timers { margin:.6rem 0 0; padding-left:1.1rem; color:var(--dim); font-size:.9rem; }
  footer { margin-top:2.5rem; color:var(--dim); font-size:.8rem; }
</style></head>
<body><main>
  <h1>${esc(s.crew)}</h1>
  <p class="sub">${s.runs.length} run${s.runs.length === 1 ? '' : 's'} in flight ·
     ${s.unclaimed} order${s.unclaimed === 1 ? '' : 's'} free ·
     ${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}${s.overdue.length ? ` · <span class="overdue">${s.overdue.length} lease${s.overdue.length === 1 ? '' : 's'} overdue</span>` : ''}</p>

  <h2>What needs a person</h2>
  ${needs}

  <h2>What is running</h2>
  ${s.runs.length ? s.runs.map((r) => runCard(r, s.at)).join('') : '<p class="dim">Nothing is running.</p>'}

  <footer>Read-only. Loopback only — there is no authentication, and this page
  changes nothing. Same facts as <code>/dashboard.json</code>.</footer>
</main></body></html>`;
}

/**
 * The `extra` handler serveBroker calls before its own routes.
 * @returns {(req, res) => boolean} true when it handled the request
 */
export function dashboardRoutes(facts) {
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '/dashboard' && path !== '/dashboard.json') return false;

    // The server binds loopback, so this cannot normally be reached from
    // elsewhere. Checked anyway: a bind is a configuration and this is the
    // property — nothing here is behind a password.
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('polycrew dashboard is loopback-only\n');
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
      res.end('the dashboard is read-only\n');
      return true;
    }

    facts().then((s) => {
      const json = path === '/dashboard.json';
      const body = json ? JSON.stringify(s) : page(s);
      res.writeHead(200, {
        'content-type': json ? 'application/json' : 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`dashboard: ${err?.message ?? err}\n`);
    });
    return true;
  };
}
