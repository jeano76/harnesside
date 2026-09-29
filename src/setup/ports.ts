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
  /**
   * 이미 떠 있던 서버를 **채택**했으면 그 사실.
   *
   * 채택은 "포트를 정한 결과" 가 아니라 "**스폰하지 않았다**" 는 사실이라 `moved` 와
   * 다르다. 이 표시가 있어야 호출자가 (a) 두 번째 서버를 띄우지 않고
   * (b) 종료할 때 **남의 서버를 죽이지 않는다** 고 판단할 수 있다.
   *
   * 없으면 우리가 직접 띄운 서버다 — 이 구분이 없으면 사용자 서버까지 죽인다.
   */
  adopted?: { port: number; model: string };
}

/**
 * 이미 떠 있는 OpenAI 호환 서버를 **채택**했을 때 넘긴다.
 *
 * 이게 없으면 `planPorts` 는 "포트가 사용 중이다" 만 보고 **옮겨 버린다.** 그런데 그
 * 사용 중인 포트를 우리가 고른 이유가 바로 "**거기 이미 서버가 있다**" 이므로, 옮기면
 * 두 번째 서버를 띄우게 된다 — 실측된 OOM(`cudaMalloc failed`, 1476 MiB 요청 /
 * 321 MiB 여유) 과 정확히 같은 경로. 실제로 그랬다: 8080 에 정상 llama-server 가
 * 있는데도 8081 로 옮겨 두 번째 모델을 띄웠다.
 *
 * 그래서 판정(adopt)과 포트 결정은 **같은 함수 안에서** 한다. 순서를 분리하면
 * "이미 확인한 포트를 다시 두드리는" 죽은 코드가 된다 — 실제로 그랬다.
 */
export interface AdoptedLlama {
  port: number;
  /** 채택한 서버가 `/v1/models` 로 알려 준 모델 이름. */
  model: string;
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
  /** 이미 떠 있는 서버를 채택했다면 그 포트. 있으면 **옮기지 않는다.** */
  adoptedLlama?: AdoptedLlama;
}): Promise<PortPlan> {
  const { probe } = opts;
  const moved: PortPlan["moved"] = [];
  const notes: string[] = [];

  let llamaPort = opts.llamaPort ?? LLAMA_PORT;
  if (opts.adoptedLlama) {
    // **사용 중이라는 이유로 옮기지 않는다.** 그 포트를 고른 이유가 "거기에 서버가
    // 이미 있다" 이기 때문이다. 옮기면 우리가 띄울 두 번째 서버의 포트를 정하는 셈이고,
    // 그 경로는 실측된 OOM 이다. 여기서 `probe` 를 두드리지 않는 것도 같은 이유 —
    // 답은 이미 알고 있다.
    llamaPort = opts.adoptedLlama.port;
    notes.push(`llama 포트 ${llamaPort}: 이미 떠 있는 서버를 채택(${opts.adoptedLlama.model}) — 포트를 옮기지 않습니다.`);
  } else {
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

  return { llamaPort, idePort, moved, notes, adopted: opts.adoptedLlama };
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
