// The link between sessions of one crew.
//
// Binding the crew's port IS the election: the operating system hands it to
// exactly one process, so there is no consensus protocol and no leader lease
// (spec MA-22). The winner opens the store and runs the engine; everyone else
// forwards their tool calls to it over loopback.
//
// Two timing rules make the difference between this working and being flaky:
//
//   1. A bound port does not mean a ready broker. The server answers 503 until
//      the engine has started, and callers retry — otherwise the first call
//      after an election races the store opening.
//   2. A refused connection is not an error, it is an election. The caller
//      tries to bind; if it wins it serves itself, if it loses someone else
//      just won and it retries.

import { createServer, request as httpRequest } from 'node:http';

export const LOOPBACK = '127.0.0.1';

/**
 * Try one port. Three outcomes, and they are not the same:
 *   - a bound server        this session is the broker
 *   - EADDRINUSE            someone already is; talk to them
 *   - EACCES                the machine will not give anyone this port
 *
 * The third is not hypothetical: Windows reserves large blocks of the dynamic
 * range for Hyper-V and WSL, and a bind there fails with EACCES rather than
 * EADDRINUSE. Reading that as "another broker has it" makes every session a
 * proxy to nothing, which is exactly what it did the first time.
 */
function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (err) => {
      server.close();
      if (err.code === 'EADDRINUSE') resolve({ taken: true });
      else if (err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL') resolve({ unusable: true });
      else reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve({ server });
    });
  });
}

/** Does anything answer on that port? A broker that is merely starting still does. */
export function ping(port, { host = LOOPBACK, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 || res.statusCode === 503);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Find this crew's broker port and either hold it or name it.
 *
 * A failed bind is not proof that a broker is there. Windows keeps reserved
 * port ranges — Hyper-V, WSL — where bind returns EADDRINUSE or EACCES with
 * nothing listening at all; this machine refuses a contiguous 4,000-port block
 * that way. A session that believed the error became a proxy to nobody.
 *
 * So the port belongs to a broker only when something ANSWERS on it. Otherwise
 * it is unusable and the crew moves to the next candidate together, since every
 * session walks the same list in the same order.
 *
 * @param {number[]} ports  candidates, in agreed order (registry.portsFor)
 * @returns {Promise<{server: import('node:http').Server|null, port: number}>}
 */
export async function acquire(ports, { host = LOOPBACK, settleMs = 120 } = {}) {
  const candidates = Array.isArray(ports) ? ports : [ports];
  for (const port of candidates) {
    let outcome = await tryBind(port, host);
    if (outcome.server) return { server: outcome.server, port };
    if (outcome.taken && await ping(port, { host })) return { server: null, port };

    if (outcome.taken) {
      // Nothing answered: either a broker died a moment ago and its socket is
      // still closing, or the machine reserves this port. Give the first case
      // one chance before writing the port off.
      await wait(settleMs);
      outcome = await tryBind(port, host);
      if (outcome.server) return { server: outcome.server, port };
      if (outcome.taken && await ping(port, { host })) return { server: null, port };
    }
  }
  throw new Error(
    `no usable port for this crew among ${candidates.length} candidates `
    + `(${candidates[0]}…): all refused by this machine with nothing listening. `
    + 'On Windows see `netsh interface ipv4 show excludedportrange protocol=tcp`.',
  );
}

/** Read a JSON body, with a ceiling so a wedged client cannot grow the heap. */
function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const send = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/**
 * Serve this crew on the port we won.
 *
 *   GET  /health   200 once the engine is up, 503 while it is still starting
 *   GET  /info     who the broker is, for the dashboard and for humans
 *   POST /rpc      {method, params} — one forwarded tool call
 *
 * The 503 matters as much as the 200: binding the port is instant, opening the
 * store is not, and a proxy that called in between would otherwise get a
 * half-built engine. It answers 503, the caller retries, nothing races.
 *
 * @param {import('node:http').Server} server  the bound server from acquire()
 * @param {{ready: () => boolean, call: (m: string, p: object) => Promise<any>,
 *           info: () => object, extra?: (req, res) => boolean}} handlers
 */
export function serveBroker(server, { ready, call, info, extra }) {
  server.on('request', async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (extra?.(req, res)) return;                       // the dashboard mounts here
    if (path === '/health') return send(res, ready() ? 200 : 503, { ok: ready() });
    if (path === '/info') return send(res, 200, info());
    if (path !== '/rpc') return send(res, 404, { error: `no route ${path}` });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST /rpc' });
    if (!ready()) return send(res, 503, { error: 'broker starting' });

    try {
      const { method, params } = await readJson(req);
      return send(res, 200, { result: await call(method, params ?? {}) });
    } catch (err) {
      // A tool that threw is a failed call, not a dead broker: 400, never 503,
      // or the caller would read it as an election and try to take the port.
      return send(res, 400, { error: err?.message ?? String(err) });
    }
  });
  // The link must never be what holds the process open at shutdown.
  server.unref?.();
  return server;
}

class BrokerGone extends Error {
  constructor(msg) { super(msg); this.brokerGone = true; }
}

/** One request to this crew's broker. A refused or half-started broker is a BrokerGone. */
export function askBroker(port, method, params = {}, { host = LOOPBACK, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = httpRequest({
      host, port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode === 503) return reject(new BrokerGone('broker starting'));
        let parsed;
        try { parsed = JSON.parse(text); } catch { return reject(new Error(`bad reply: ${text.slice(0, 200)}`)); }
        if (res.statusCode !== 200) return reject(new Error(parsed.error ?? `http ${res.statusCode}`));
        return resolve(parsed.result);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('broker timed out')); });
    req.on('error', (err) => reject(
      ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE'].includes(err.code)
        ? new BrokerGone(`broker unreachable (${err.code})`)
        : err,
    ));
    req.end(body);
  });
}


export const isBrokerGone = (err) => Boolean(err?.brokerGone);
