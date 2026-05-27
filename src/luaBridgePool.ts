/**
 * Pool of LuaBridge subprocesses for parallel read-only calc operations.
 *
 * Why: a single bridge serializes calc_with calls. For tools like
 * suggestNodeSwaps that fire ~100+ probes, distributing across N bridges
 * gives a near-linear speedup at the cost of N×~200MB RAM per extra worker.
 *
 * Lifecycle:
 *   - Pool spawns N bridges at startup, all empty (no build loaded).
 *   - When a build is loaded into the PRIMARY bridge (via lua_load_build),
 *     the pool re-syncs the rest by exporting the primary's XML and loading
 *     it into every replica.
 *   - All pool.send() / pool.batchSend() requests round-robin across replicas.
 *   - Mutating actions (set_level, add_gem, etc.) must NOT use the pool —
 *     they only mutate the primary, leaving replicas stale. Use primary
 *     directly for those.
 *
 * The contract: callers know which actions are mutating vs read-only. We
 * don't enforce it at the API layer.
 */

import { LuaBridge, type LuaBridgeOptions, type LuaResponse } from "./luaBridge.js";

type LuaRequest = { action: string; params?: Record<string, unknown> };

export interface BridgeLike {
  send(req: LuaRequest): Promise<LuaResponse>;
  isAlive(): boolean;
}

export interface PoolOptions extends LuaBridgeOptions {
  /** Pool size (extra bridges beyond the primary). Default 0 (no pool). */
  size: number;
}

export class LuaBridgePool implements BridgeLike {
  private replicas: LuaBridge[] = [];
  private rrIndex = 0;
  private readonly primary: LuaBridge;
  private readonly options: PoolOptions;
  private starting: Promise<void> | null = null;

  constructor(primary: LuaBridge, options: PoolOptions) {
    this.primary = primary;
    this.options = options;
  }

  /** True iff the primary AND all replicas are running. */
  isAlive(): boolean {
    return this.primary.isAlive() && this.replicas.every((r) => r.isAlive());
  }

  /** Total worker count (1 primary + N replicas). */
  get size(): number {
    return 1 + this.replicas.length;
  }

  /**
   * Spawn replicas, sync'd to the primary's current build state.
   *
   * The primary must already be started + have its current build state set.
   * If `primaryBuildXml` is provided, replicas load that. Otherwise we ask
   * the primary to export its current state.
   */
  async startReplicas(primaryBuildXml?: string): Promise<void> {
    if (this.starting) return this.starting;
    if (this.replicas.length >= this.options.size) return;
    this.starting = this.doStart(primaryBuildXml).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(primaryBuildXml?: string): Promise<void> {
    const needed = this.options.size - this.replicas.length;
    if (needed <= 0) return;

    // Spawn replicas in parallel — startup is the slow part (~8s each cold).
    const fresh: LuaBridge[] = [];
    for (let i = 0; i < needed; i++) {
      const b = new LuaBridge({
        forkPath: this.options.forkPath,
        wslDistro: this.options.wslDistro,
        timeoutMs: this.options.timeoutMs,
      });
      fresh.push(b);
    }
    const startResults = await Promise.allSettled(fresh.map((b) => b.start()));
    const errors = startResults
      .map((r, i) => (r.status === "rejected" ? `replica ${i}: ${(r as PromiseRejectedResult).reason}` : null))
      .filter(Boolean);
    if (errors.length) {
      // Clean up any that did start
      await Promise.allSettled(fresh.map((b) => (b.isAlive() ? b.stop() : null)));
      throw new Error(`Pool startup failed: ${errors.join("; ")}`);
    }

    // Sync each replica to the primary's build state
    let xml = primaryBuildXml;
    if (!xml) {
      const exp = await this.primary.send({ action: "export_build_xml" });
      if (exp.ok !== false && typeof exp.xml === "string") xml = exp.xml;
    }
    if (xml) {
      // load_build_xml in parallel across replicas
      await Promise.all(
        fresh.map((b) =>
          b.send({ action: "load_build_xml", params: { xml, name: "pool-replica" } })
        )
      );
    }
    this.replicas.push(...fresh);
  }

  /** Re-sync all replicas to the primary's current state (after a mutation). */
  async resyncFromPrimary(): Promise<void> {
    if (this.replicas.length === 0) return;
    const exp = await this.primary.send({ action: "export_build_xml" });
    if (exp.ok === false || typeof exp.xml !== "string") {
      throw new Error("resync: primary export_build_xml failed");
    }
    // new_build first so old state doesn't bleed (load_build_xml is additive)
    await Promise.all(
      this.replicas.map(async (b) => {
        await b.send({ action: "new_build" });
        await b.send({ action: "load_build_xml", params: { xml: exp.xml as string, name: "pool-resync" } });
      })
    );
  }

  /** Round-robin send. Use only for read-only actions (calc_with, get_stats, etc). */
  async send(req: LuaRequest): Promise<LuaResponse> {
    const all = [this.primary, ...this.replicas];
    const b = all[this.rrIndex % all.length];
    this.rrIndex++;
    return b.send(req);
  }

  /**
   * Fan out an array of requests across all workers. Returns results in the
   * same order as the input. Use for batch probes like calc_with sweeps.
   */
  async batchSend(reqs: LuaRequest[]): Promise<LuaResponse[]> {
    const all = [this.primary, ...this.replicas];
    if (all.length === 1) {
      // Single-bridge fast-path (serial)
      const results: LuaResponse[] = [];
      for (const r of reqs) results.push(await all[0].send(r));
      return results;
    }
    // Split reqs into chunks, one per worker. Each worker processes its chunk
    // serially (a single bridge can't handle concurrent stdio anyway).
    const chunks: Array<{ idx: number; req: LuaRequest }[]> = all.map(() => []);
    reqs.forEach((req, idx) => {
      chunks[idx % all.length].push({ idx, req });
    });
    const out: LuaResponse[] = new Array(reqs.length);
    await Promise.all(
      chunks.map(async (chunk, workerIdx) => {
        const worker = all[workerIdx];
        for (const { idx, req } of chunk) {
          out[idx] = await worker.send(req);
        }
      })
    );
    return out;
  }

  async stop(): Promise<void> {
    await Promise.all(this.replicas.map((b) => b.stop().catch(() => undefined)));
    this.replicas.length = 0;
  }
}
