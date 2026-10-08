/**
 * Remote browser control over the Chrome DevTools Protocol (CDP), so the
 * agent can drive/inspect a browser the user already has running with
 * --remote-debugging-port=<port> — this never launches or manages a
 * browser process itself, only attaches to one that's already listening.
 * Uses Node's built-in WebSocket (stable since Node 22), so no extra
 * dependency is needed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BrowserConfig {
  debugPort: number;
  host?: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function endpoint(config: BrowserConfig): string {
  return `http://${config.host ?? "127.0.0.1"}:${config.debugPort}`;
}

async function listTargets(config: BrowserConfig): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`${endpoint(config)}/json/list`);
  } catch (err: any) {
    throw new Error(
      `couldn't reach the browser debug port at ${endpoint(config)} (${err.message}) — ` +
        `make sure the browser was started with --remote-debugging-port=${config.debugPort}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `couldn't reach the browser debug port at ${endpoint(config)} (${res.status}) — ` +
        `make sure the browser was started with --remote-debugging-port=${config.debugPort}`
    );
  }
  return (await res.json()) as CdpTarget[];
}

async function pickTarget(config: BrowserConfig, targetId?: string): Promise<CdpTarget> {
  const targets = await listTargets(config);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (targetId) {
    const found = pages.find((t) => t.id === targetId);
    if (!found) throw new Error(`no open page tab with id ${targetId}`);
    return found;
  }
  if (pages.length === 0) throw new Error("no open page tabs found on the browser debug port");
  return pages[0];
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  waitForEvent(method: string, timeoutMs?: number): Promise<any>;
  close(): void;
  /** False once the socket closed/errored or a command timed out — a
   *  session in that state is never handed out again. */
  readonly healthy: boolean;
}

/** Default timeout for both connecting and each individual CDP command —
 *  exported so tests can shrink it instead of waiting out the real
 *  default, same pattern as tools/index.ts's RUN_SHELL_TIMEOUT_MS. */
export let CDP_TIMEOUT_MS = 15_000;
export function setCdpTimeoutForTests(ms: number): void {
  CDP_TIMEOUT_MS = ms;
}

/** Opens one CDP WebSocket session. Sessions are cached per tab and reused
 *  across tool calls (see withSession). */
function openSession(wsUrl: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const eventWaiters = new Map<string, Array<(params: any) => void>>();
    let nextId = 0;
    let healthy = true;

    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out connecting to ${wsUrl}`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        // No timeout here previously — if the browser tab never sends a
        // response for this command id (it crashed, hung, navigated away
        // mid-command, or the connection silently stalled without an
        // actual WebSocket error event), this promise waited forever,
        // hanging the entire agent turn indefinitely. Same class of bug
        // already fixed for run_shell (tools/index.ts) — a tool call must
        // always fail visibly within a bounded time instead of blocking
        // the whole loop. Reuses the same timeoutMs the session's own
        // connect step uses, for a consistent bound across the whole
        // session lifetime rather than a separate magic number.
        send(method, params = {}) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              // A tab that stopped answering one command can't be trusted
              // with the next — drop it so the next call reconnects.
              healthy = false;
              ws.close();
              rej(new Error(`timed out waiting for a response to ${method} (CDP command id ${id})`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        waitForEvent(method, waitMs = timeoutMs) {
          return new Promise((res, rej) => {
            const waiter = (params: any) => {
              clearTimeout(timer);
              res(params);
            };
            // Remove the waiter on timeout: with a reused session a stale
            // one would otherwise sit there and swallow a later call's event.
            const timer = setTimeout(() => {
              const list = eventWaiters.get(method);
              if (list) eventWaiters.set(method, list.filter((w) => w !== waiter));
              rej(new Error(`timed out waiting for ${method}`));
            }, waitMs);
            eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), waiter]);
          });
        },
        close() {
          healthy = false;
          ws.close();
        },
        get healthy() {
          return healthy && ws.readyState === WebSocket.OPEN;
        },
      });
    });

    ws.addEventListener("message", (ev: any) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const waiters = eventWaiters.get(msg.method);
        if (waiters?.length) {
          eventWaiters.set(msg.method, []);
          waiters.forEach((w) => w(msg.params));
        }
      }
    });

    ws.addEventListener("error", (err: any) => {
      healthy = false;
      clearTimeout(openTimer);
      reject(new Error(`CDP connection error: ${err?.message ?? err}`));
    });

    // The tab closed or the browser went away: fail in-flight commands now
    // instead of letting each wait out its own timeout.
    ws.addEventListener("close", () => {
      healthy = false;
      for (const p of pending.values()) p.reject(new Error("CDP connection closed"));
      pending.clear();
    });
  });
}

/** An idle cached session is closed after this long, so a browser the
 *  agent stopped using isn't held open by us indefinitely. */
const SESSION_IDLE_MS = 30_000;

interface CachedSession {
  session: Promise<CdpSession>;
  idleTimer?: NodeJS.Timeout;
  inFlight: number;
}

/** P2-1: was one WebSocket handshake per browser_* call. An agent driving
 *  a page does navigate → eval → eval → screenshot back to back, so keep
 *  the tab's session open and reuse it. /json/list is still fetched every
 *  call — it's a local HTTP GET, and it's what tells us the tab still
 *  exists and which one is the default. */
const sessions = new Map<string, CachedSession>();

function dropSession(wsUrl: string, entry: CachedSession): void {
  if (sessions.get(wsUrl) !== entry) return;
  sessions.delete(wsUrl);
  clearTimeout(entry.idleTimer);
  entry.session.then((s) => s.close(), () => {});
}

async function acquireSession(wsUrl: string): Promise<CachedSession> {
  const cached = sessions.get(wsUrl);
  if (cached) {
    const s = await cached.session.catch(() => null);
    if (s?.healthy) return cached;
    dropSession(wsUrl, cached);
  }
  const entry: CachedSession = { session: openSession(wsUrl), inFlight: 0 };
  sessions.set(wsUrl, entry);
  try {
    await entry.session;
  } catch (err) {
    dropSession(wsUrl, entry);
    throw err;
  }
  return entry;
}

async function withSession<T>(
  config: BrowserConfig,
  targetId: string | undefined,
  fn: (session: CdpSession) => Promise<T>
): Promise<T> {
  const target = await pickTarget(config, targetId);
  const wsUrl = target.webSocketDebuggerUrl!;
  const entry = await acquireSession(wsUrl);
  clearTimeout(entry.idleTimer);
  entry.inFlight++;
  const session = await entry.session;
  try {
    return await fn(session);
  } finally {
    entry.inFlight--;
    if (!session.healthy) dropSession(wsUrl, entry);
    else if (entry.inFlight === 0) {
      entry.idleTimer = setTimeout(() => dropSession(wsUrl, entry), SESSION_IDLE_MS);
      entry.idleTimer.unref();
    }
  }
}

/** Closes every cached CDP session (shutdown, tests). */
export function closeBrowserSessions(): void {
  for (const [url, entry] of [...sessions]) dropSession(url, entry);
}

export async function listTabs(config: BrowserConfig): Promise<string> {
  const targets = await listTargets(config);
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return "(no open page tabs)";
  return pages.map((t) => `${t.id}  ${t.title || "(untitled)"}  ${t.url}`).join("\n");
}

export async function navigate(config: BrowserConfig, url: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    await session.send("Page.enable");
    const loaded = session.waitForEvent("Page.loadEventFired", 20_000);
    await session.send("Page.navigate", { url });
    await loaded;
    return `navigated to ${url}`;
  });
}

export async function evaluate(config: BrowserConfig, expression: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    const result = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw");
    }
    const value = result.result?.value;
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

export async function screenshot(config: BrowserConfig, outPath: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    const result = await session.send("Page.captureScreenshot", { format: "png" });
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(result.data, "base64"));
    return outPath;
  });
}

/** Is a debuggable browser actually reachable right now?
 *
 *  Drives whether the browser tools are offered to the model at all
 *  (tools/index.ts activeToolDefs, wired in index.tsx at startup). They
 *  are useless without one — every call would just fail with "couldn't
 *  reach the browser debug port" — while still costing ~400-500 prompt
 *  tokens on EVERY request for their schema (measured against the real
 *  backend: the full tool schema is 1,238 tokens, 7.6% of a
 *  16,384-token window). So: probe once, offer them only if a browser is
 *  really there. Short timeout because this runs on the startup path and
 *  a firewalled/black-holed port must not stall launch; any failure means
 *  "not available", never an error. */
export async function isBrowserAvailable(config: BrowserConfig, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint(config)}/json/version`, { signal: controller.signal as any });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
