/**
 * The one place that decides which port harnesside talks to, so the configured
 * port and the port llama-server binds cannot disagree.
 *
 * ── What this used to do, and why it is smaller now ─────────────────────────
 * There were once two ports: llama-server and a `laya` "System 1" helper that
 * was consulted before each turn (see the removed `/fastcheck`). Both the
 * helper and its port are gone, so exactly one port remains and the collision
 * logic that existed to stop the two servers fighting over 8099 is gone with
 * it. `layaPortEnv()` went the same way — its whole reason for existing was
 * making the Python side's bind port and its health probe agree, and there is
 * no Python side any more.
 *
 * ── The problem that remains ────────────────────────────────────────────────
 * The port was once an independent fact per component: `detect.ts` probed
 * 8080/8081/11434 and took the first responder, while a separate spawn default
 * said 8081. Which port the next run used therefore depended on what else
 * happened to be running. The requirement is simply that the port harnesside
 * talks to and the port llama-server binds are the same number by
 * construction — decided once, written once, and re-asserted on every launch.
 */

export const LLAMA_PORT = 8080;

/** The web IDE's own HTTP + WebSocket port (부록 A). A second port because the
 *  browser window and the model server are independent processes: killing or
 *  moving one must not silently move the other. */
export const IDE_PORT = 7317;

/** Ports harnesside will probe for an already-running OpenAI-compatible server
 *  when a project has no config yet. The candidates are ORDERED and the first
 *  responder wins, so our own port leads: if harnesside is already serving, that
 *  is unambiguously the right answer. */
export const COMMON_PORTS = [LLAMA_PORT, 11434];

export type PortState = "free" | "in-use" | "unknown";

/** Whether something is listening on `port`.
 *
 *  A pure TCP connect, deliberately: it answers "is this port taken", which is
 *  the only question here, without depending on an HTTP server existing there
 *  (a *foreign* process squatting on 8080 is exactly the case this must
 *  detect). Injected so the whole module is testable without binding real
 *  ports. */
export type PortProbe = (port: number) => Promise<PortState>;

export const tcpPortProbe: PortProbe = async (port) => {
  const net = await import("node:net");
  return new Promise<PortState>((resolve) => {
    const socket = new net.Socket();
    // A short timeout: probing several ports sequentially on a machine with a
    // firewall that DROPs rather than REJECTs would otherwise hang for the OS
    // default (~2 min) per port.
    const timer = setTimeout(() => { socket.destroy(); resolve("unknown"); }, 400);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("in-use"); });
    socket.once("error", () => { clearTimeout(timer); resolve("free"); });
    socket.connect(port, "127.0.0.1");
  });
};

export interface PortPlan {
  llamaPort: number;
  idePort: number;
  /** Set when a port had to be moved, so the reason is reported rather than
   *  silently changing where the server lives between runs. */
  moved: { what: "llama" | "ide"; from: number; to: number; because: string }[];
  notes: string[];
}

/**
 * Resolves the port.
 *
 * `wanted` lets a caller pass a port that is already recorded in a config
 * (i.e. one this harnesside install set up before), so an established install
 * keeps its port instead of being migrated on every launch. A port that is
 * already occupied by something *else* is moved, because a port conflict is
 * precisely the failure this whole module exists to prevent — and it is
 * reported, never silently absorbed.
 */
export async function planPorts(opts: {
  probe: PortProbe;
  llamaPort?: number;
  idePort?: number;
}): Promise<PortPlan> {
  const { probe } = opts;
  const moved: PortPlan["moved"] = [];
  const notes: string[] = [];

  let llamaPort = opts.llamaPort ?? LLAMA_PORT;
  const llamaState = await probe(llamaPort);
  if (llamaState === "free" || llamaState === "unknown") {
    if (llamaState === "unknown") {
      // Treated as usable: a firewall that DROPs the probe says nothing about
      // whether the port is bindable, and refusing to start on that evidence
      // would make harnesside fail on a locked-down network for no reason.
      notes.push(`llama 포트 ${llamaPort} 응답 없음(방화벽) — 그대로 사용을 시도합니다.`);
    }
  } else {
    // Occupied. Prefer 8080 itself if the caller merely inherited a stale value
    // and our canonical port is free; otherwise walk forward.
    if (llamaPort !== LLAMA_PORT && (await probe(LLAMA_PORT)) === "free") {
      moved.push({ what: "llama", from: llamaPort, to: LLAMA_PORT, because: "기록된 포트가 사용 중이고 기본 포트가 비어 있음" });
      llamaPort = LLAMA_PORT;
    } else {
      const next = await firstFree(probe, llamaPort + 1, llamaPort + 20);
      moved.push({ what: "llama", from: llamaPort, to: next, because: "이미 사용 중" });
      llamaPort = next;
    }
  }

  // The IDE port is planned on the same terms, and crucially it is *distinct*
  // from the llama port: a plan that moved llama onto 7317 would hand the model
  // server the browser's port and produce a failure that looks like a bug in the
  // launcher rather than a port collision. The llama walk starts at +1 for the
  // same reason — it must never land on IDE_PORT.
  let idePort = opts.idePort ?? IDE_PORT;
  if (idePort === llamaPort) {
    const next = await firstFree(probe, IDE_PORT + 1, IDE_PORT + 20, llamaPort);
    moved.push({
      what: "ide",
      from: idePort,
      to: next,
      because: `llama 포트(${llamaPort})와 겹쳐서 이동했습니다`,
    });
    idePort = next;
  } else {
    const ideState = await probe(idePort);
    if (ideState === "in-use") {
      const next = await firstFree(probe, idePort + 1, idePort + 20, llamaPort);
      moved.push({ what: "ide", from: idePort, to: next, because: "이미 사용 중" });
      idePort = next;
    } else if (ideState === "unknown") {
      notes.push(`IDE 포트 ${idePort} 응답 없음(방화벽) — 그대로 사용을 시도합니다.`);
    }
  }

  return { llamaPort, idePort, moved, notes };
}

/** First free port in [from, to], skipping `reserved` (the other service's
 *  port). Returns `to` when the range is exhausted — the caller reports that as
 *  a collision rather than pretending the port is free. */
async function firstFree(probe: PortProbe, from: number, to: number, reserved?: number): Promise<number> {
  for (let p = from; p <= to; p++) {
    if (p === reserved) continue;
    if ((await probe(p)) === "free") return p;
  }
  return to;
}
