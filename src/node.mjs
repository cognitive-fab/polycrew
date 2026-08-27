// One session of a crew: broker or proxy, and able to change its mind.
//
// Every session runs this. Whoever binds the crew's port opens the store and
// runs the engine; the rest forward to it. A session that finds the broker gone
// tries to take over — winning means it serves itself from then on, losing
// means someone else just won and the call is retried against them.
//
// The store is opened by the broker alone. A proxy never touches SQLite, which
// is what keeps one writer per file and lets a crew work without Postgres.

import { Polyflow, makeTools } from 'polyflow';

import { crewTools } from './crew-tools.mjs';
import { acquire, askBroker, isBrokerGone, serveBroker } from './link.mjs';
import { StoreBroker } from './store-broker.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CrewNode {
  constructor({ area, agent, actor, roles = [], ports, store, orders, workflows, log = () => {} }) {
    Object.assign(this, { area, agent, actor, roles, store, orders, workflows, log });
    this.candidates = Array.isArray(ports) ? ports : [ports];
    this.port = this.candidates[0];
    this.mode = 'unknown';
    this.pf = null;
    this.broker = null;
    this.server = null;
    this.tools = null;
    this.ready = false;
  }

  /** Bind or forward. Either way, `this.tools` is a usable MCP tool list afterwards. */
  async start() {
    const { server, port } = await acquire(this.candidates);
    this.port = port;
    if (server) await this.becomeBroker(server);
    else await this.becomeProxy();
    return this;
  }

  // -- broker ---------------------------------------------------------------

  async becomeBroker(server) {
    this.server = server;
    this.mode = 'broker';
    // Bound but not ready: /rpc answers 503 until the engine is up, so the
    // first call after an election cannot race the store opening.
    serveBroker(server, {
      ready: () => this.ready,
      call: (method, params) => this.invoke(method, params),
      info: () => ({ crew: this.area, actor: this.actor, port: this.port, pid: process.pid, mode: this.mode }),
    });

    this.broker = new StoreBroker({ dbPath: this.orders });
    this.pf = new Polyflow({
      workflowsDir: this.workflows, dbPath: this.store,
      agent: this.agent, instance: this.area, broker: this.broker,
    });
    await this.pf.start();
    // polyflow's six, plus the two a crew needs. The roles came from the
    // environment at boot and are fixed for the life of the process — a
    // session that could widen its own roles could approve its own work.
    this.localTools = makeTools(this.pf, crewTools({ broker: this.broker, roles: this.roles }));
    // The stdio path calls handler(args) with no actor, so bind our own here;
    // the /rpc path passes the forwarding session's actor explicitly.
    this.tools = this.localTools.map((t) => ({ ...t, handler: (args) => t.handler(args, this.actor) }));
    this.ready = true;
    this.log(`broker on :${this.port}`);
  }

  /** Run a tool here. The broker is the only process that ever does this. */
  async invoke(method, params) {
    if (method === 'tools/list') {
      return this.localTools.map(({ name, description, inputSchema, outputSchema, annotations }) =>
        ({ name, description, inputSchema, outputSchema, annotations }));
    }
    if (method === 'tools/call') {
      const tool = this.localTools.find((t) => t.name === params.name);
      if (!tool) throw new Error(`unknown tool '${params.name}'`);
      // The actor rides beside the arguments, never inside them: it is not
      // something a model supplies, so it must not look like something it could.
      return tool.handler(params.arguments ?? {}, params.actor ?? this.actor);
    }
    throw new Error(`unknown method '${method}'`);
  }

  // -- proxy ----------------------------------------------------------------

  async becomeProxy() {
    this.mode = 'proxy';
    this.log(`proxy to :${this.port}`);
    const defs = await this.ask('tools/list', {});
    this.tools = defs.map((def) => ({
      ...def,
      handler: (args) => this.ask('tools/call', { name: def.name, arguments: args }),
    }));
  }

  /**
   * Ask the broker, and treat its absence as an election rather than an error:
   * try to take the port, serve the call ourselves if we win, retry against
   * whoever won if we lose.
   */
  async ask(method, params, attempts = 4) {
    for (let i = 0; i < attempts; i += 1) {
      if (this.mode === 'broker') return this.invoke(method, { ...params, actor: this.actor });
      try {
        return await askBroker(this.port, method, { ...params, actor: this.actor });
      } catch (err) {
        if (!isBrokerGone(err) || i === attempts - 1) throw err;
        await this.takeOverOrWait();
      }
    }
    throw new Error(`no broker for crew ${this.area} on :${this.port}`);
  }

  async takeOverOrWait() {
    // Only this crew's port — a takeover must not wander to another one.
    // Only the port this crew settled on — a takeover must not wander.
    const { server } = await acquire([this.port]).catch(() => ({ server: null }));
    if (server) {
      this.log('broker was gone — taking over');
      await this.becomeBroker(server);
    } else {
      // Someone else won, or is still starting. Give them a moment.
      await sleep(150);
    }
  }

  // -- shutdown -------------------------------------------------------------

  async close() {
    if (this.server) await new Promise((r) => this.server.close(r));
    if (this.pf) await this.pf.close();
    if (this.broker) this.broker.close();
    this.ready = false;
  }
}
