// One polycrew process, driven over stdio JSON-RPC the way a host drives it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POLYFLOW = resolve(dirname(createRequire(import.meta.url).resolve('polyflow')), '..');

export function session(env = {}) {
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'bin', 'polycrew.mjs')], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Map();
  let stderr = '';
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.stderr.on('data', (b) => { stderr += b; });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  });

  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const mine = ++id;
    waiters.set(mine, res);
    setTimeout(() => rej(new Error(`timeout on ${method}\n${stderr}`)), 60_000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
  });

  /**
   * One tool call, unwrapped to what the tool returned. A tool that failed
   * comes back as an isError result, not a JSON-RPC error — that is MCP's
   * shape, and a test that ignored it would read a failure as a success.
   */
  const call = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${res.error.message ?? JSON.stringify(res.error)}`);
    if (res.result?.isError) {
      throw new Error(`${name}: ${res.result.content?.map((c) => c.text).join(' ') ?? 'failed'}`);
    }
    return res.result.structuredContent ?? res.result;
  };

  /**
   * 'broker' or 'proxy' — the LAST role the process took, not the first. A
   * session that took over after the broker died is a broker now, and reading
   * only the boot line would keep calling it a proxy forever.
   */
  const roleLine = () => [...stderr.matchAll(/\[polycrew\] (broker on|proxy to) :(\d+)/g)].pop();
  const mode = () => (roleLine()?.[1] === 'broker on' ? 'broker' : roleLine() ? 'proxy' : null);
  const port = () => Number(roleLine()?.[2]) || null;

  /** The id this process minted for itself - nothing chose it, including us. */
  const actor = () => /\[polycrew\] actor (\S+) /.exec(stderr)?.[1] ?? null;

  /**
   * Wait until the process has logged which role it took.
   *
   * An initialize reply arriving on STDOUT is not evidence that the role line
   * has arrived on STDERR — they are two streams, and reading mode() straight
   * after an rpc() is a race that only shows up under load. Anything that asks
   * a session what it is must wait for it to have said so.
   */
  const ready = async (timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mode()) return mode();
      if (exited) throw new Error(`session exited before taking a role
${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`session never said what role it took
${stderr}`);
  };

  return { rpc, call, mode, port, actor, ready, kill: (sig) => child.kill(sig), stderr: () => stderr, pid: child.pid, exited: () => exited };
}

export const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
