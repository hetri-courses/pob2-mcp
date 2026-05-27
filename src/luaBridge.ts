/**
 * Lua bridge: persistent LuaJIT subprocess running PoB2's patched HeadlessWrapper.lua
 * in api-stdio mode. Communicates over stdin/stdout via newline-delimited JSON-RPC.
 *
 * Pattern adapted from ianderse/pob-mcp's pobLuaBridge.ts (GPL-3.0). Improvements
 * over the original:
 *   - No hardcoded default path; POB_FORK_PATH is explicitly required.
 *   - WSL-aware: defaults to spawning via wsl on Windows since LuaJIT runs in
 *     Ubuntu (no native Windows LuaJIT package is reliably available).
 *   - Bounded stdout buffer (defense against runaway output).
 *   - Request queue instead of "concurrent request not supported" reject.
 *
 * Protocol (server side: pob2-fork/src/API/Server.lua):
 *   - Server emits one ready banner JSON: {ok:true, ready:true, version:{...}}
 *   - Client sends:    {action: "<name>", params?: {...}}
 *   - Server replies:  {ok: true, ...result} | {ok: false, error: "..."}
 *   - On {action:"quit"} the server emits ack and exits.
 */

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MB hard cap on accumulated stdout
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LuaBridgeOptions {
  /** Absolute path to the PoB2 fork's `src` directory (contains HeadlessWrapper.lua). */
  forkPath: string;
  /** WSL distro name if spawning via wsl; if undefined, runs `luajit` directly. */
  wslDistro?: string;
  /** Override the launcher command (default: "wsl" when wslDistro set, else "luajit"). */
  cmd?: string;
  /** Override args (advanced; default is computed from forkPath + WSL settings). */
  args?: string[];
  /** Per-request timeout in ms. Default 30s; build calcs can be slow. */
  timeoutMs?: number;
}

type LuaRequest = { action: string; params?: Record<string, unknown> };
export type LuaResponse = { ok: boolean; error?: string; [key: string]: unknown };

export class LuaBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LuaBridgeError";
    if (options?.cause) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

/** Convert a Windows path to a WSL /mnt/<drive>/... path. */
function winPathToWsl(p: string): string {
  // Match "X:\..." or "X:/..." and convert
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  const [, drive, rest] = m;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

export class LuaBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private bufferBytes = 0;
  private ready = false;
  private killed = false;
  private readonly options: Required<Pick<LuaBridgeOptions, "forkPath" | "timeoutMs">> &
    LuaBridgeOptions;
  private readonly events = new EventEmitter();
  // Queue: FIFO of pending requests. We send one, wait for response, send next.
  private readonly queue: Array<{
    req: LuaRequest;
    resolve: (r: LuaResponse) => void;
    reject: (e: Error) => void;
  }> = [];
  private inflight = false;

  constructor(options: LuaBridgeOptions) {
    if (!options.forkPath) throw new LuaBridgeError("forkPath is required");
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    // Swallow EventEmitter 'error' events so they don't bubble up as uncaught
    this.events.on("error", () => {});
  }

  /** True iff the subprocess is running and has emitted its ready banner. */
  isAlive(): boolean {
    return !this.killed && this.ready && !!this.proc;
  }

  /** Spawn LuaJIT + PoB2 and wait for the ready banner. Throws on init failure. */
  async start(): Promise<void> {
    if (this.proc) return;
    const { cmd, args } = this.buildSpawnArgs();

    try {
      this.proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Note: when going through wsl, POB_API_STDIO is passed via `--env`
        // inside buildSpawnArgs(); we don't set it on the host process env.
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LuaBridgeError(`Failed to spawn Lua bridge (${cmd}): ${msg}`, { cause: e });
    }

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    // Wrap in an object so TS doesn't narrow it to never inside the loop below
    // (the async callback assignment is invisible to control-flow analysis).
    const state: { spawnError: Error | null } = { spawnError: null };
    this.proc.on("error", (err: Error) => {
      state.spawnError = err;
      this.killed = true;
      this.events.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this.killed = true;
      this.events.emit(
        "error",
        new LuaBridgeError(`Lua bridge exited unexpectedly: code=${code} signal=${signal}`)
      );
    });

    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      // PoB2 prints a lot of startup chatter to stderr ("missing node ..." etc.)
      // Keep it visible at debug, suppress otherwise.
      if (process.env.POB2_DEBUG === "1") {
        console.error("[lua stderr]", chunk.trimEnd());
      }
    });

    // Wait for the ready banner. PoB2 startup writes ~20 lines of progress text
    // to STDOUT before our Server.lua emits valid JSON, so skip non-JSON lines.
    const deadline = Date.now() + Math.max(60_000, this.options.timeoutMs);
    while (Date.now() < deadline) {
      if (state.spawnError) {
        throw new LuaBridgeError(
          `Lua bridge spawn error: ${state.spawnError.message}`,
          { cause: state.spawnError }
        );
      }
      if (this.killed) throw new LuaBridgeError("Lua bridge process exited before becoming ready");

      let line: string;
      try {
        line = await this.readLine(deadline - Date.now());
      } catch (e) {
        throw new LuaBridgeError("Timed out waiting for ready banner", { cause: e });
      }
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const msg = JSON.parse(trimmed) as LuaResponse & { ready?: boolean };
        if (msg.ready === true) {
          this.ready = true;
          return;
        }
      } catch {
        // Non-JSON line, keep scanning
      }
    }
    throw new LuaBridgeError("Lua bridge did not emit a ready banner within the timeout");
  }

  /** Send a request and await its response. Requests are processed FIFO. */
  send(req: LuaRequest): Promise<LuaResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.drainQueue();
    });
  }

  /** Ping handler — useful for health checks. */
  async ping(): Promise<boolean> {
    const r = await this.send({ action: "ping" });
    return r.ok === true;
  }

  /** Gracefully shut down the subprocess. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.send({ action: "quit" });
    } catch {
      // ignore; we're killing it anyway
    }
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.proc = null;
    this.ready = false;
  }

  // ----- internals ---------------------------------------------------------

  private buildSpawnArgs(): { cmd: string; args: string[] } {
    if (this.options.cmd && this.options.args) {
      return { cmd: this.options.cmd, args: this.options.args };
    }

    const forkPathWsl = winPathToWsl(this.options.forkPath);
    const cwd = forkPathWsl; // PoB2's HeadlessWrapper does its own POB_SCRIPT_DIR detection

    if (process.platform === "win32") {
      // Default: invoke through WSL. The patched HeadlessWrapper detects POB_SCRIPT_DIR
      // and sets package.path correctly for /mnt/<drive>/.../runtime/lua.
      const distroArg = this.options.wslDistro ? ["-d", this.options.wslDistro] : [];
      // Forward POB_API_DEBUG so Lua-side diagnostics surface to stderr.
      const apiDebug = process.env.POB_API_DEBUG === "1" ? " POB_API_DEBUG=1" : "";
      return {
        cmd: this.options.cmd ?? "wsl",
        args: [
          ...distroArg,
          "--cd", cwd,
          "--",
          "bash", "-c", `POB_API_STDIO=1${apiDebug} exec luajit HeadlessWrapper.lua`,
        ],
      };
    }

    // Native Linux/macOS: spawn luajit directly
    return {
      cmd: this.options.cmd ?? "luajit",
      args: [...(this.options.args ?? ["HeadlessWrapper.lua"])],
    };
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, "utf8");
    if (this.bufferBytes > MAX_BUFFER_BYTES) {
      // Defense against runaway output: kill the bridge before it eats all RAM.
      this.killed = true;
      this.events.emit(
        "error",
        new LuaBridgeError(`Lua bridge stdout exceeded ${MAX_BUFFER_BYTES} bytes; killing`)
      );
      try { this.proc?.kill(); } catch { /* ignore */ }
      return;
    }
    this.events.emit("data");
  }

  /** Try to read one complete line from the buffer, waiting up to `timeoutMs`. */
  private readLine(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new LuaBridgeError("Timed out waiting for response"));
      }, Math.max(0, timeoutMs));

      const tryConsume = (): boolean => {
        const idx = this.buffer.indexOf("\n");
        if (idx < 0) return false;
        const line = this.buffer.slice(0, idx);
        const newBuffer = this.buffer.slice(idx + 1);
        this.bufferBytes -= Buffer.byteLength(this.buffer, "utf8") - Buffer.byteLength(newBuffer, "utf8");
        this.buffer = newBuffer;
        cleanup();
        resolve(line);
        return true;
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("data", onData);
        this.events.off("error", onError);
      };
      const onData = () => { tryConsume(); };
      const onError = (e: Error) => { cleanup(); reject(e); };

      if (!tryConsume()) {
        this.events.on("data", onData);
        this.events.on("error", onError);
      }
    });
  }

  /** Walk the queue: send the front item, wait for its response, repeat. */
  private async drainQueue(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        try {
          const response = await this.sendOne(item.req);
          this.queue.shift();
          item.resolve(response);
        } catch (e) {
          this.queue.shift();
          item.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      this.inflight = false;
    }
  }

  private async sendOne(req: LuaRequest): Promise<LuaResponse> {
    if (!this.proc?.stdin) throw new LuaBridgeError("Process not started");
    if (this.killed) throw new LuaBridgeError("Lua bridge has been killed");
    if (!this.ready) throw new LuaBridgeError("Lua bridge not ready");

    this.proc.stdin.write(JSON.stringify(req) + "\n");

    // Skip non-JSON noise (PoB occasionally prints diagnostics to stdout).
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.readLine(deadline - Date.now());
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        return JSON.parse(trimmed) as LuaResponse;
      } catch {
        // Not valid JSON, keep scanning
      }
    }
    throw new LuaBridgeError(`Timed out waiting for response to action="${req.action}"`);
  }
}
