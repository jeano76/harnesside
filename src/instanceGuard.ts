import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

/** Other harnesside processes running in the same project directory.
 *
 *  Reported live: the user "restarted" harnesside, but the old process (whose
 *  quit was still waiting on its running turn) kept going, and the session
 *  on screen was still the old build. Two sessions in one project also
 *  share the project's checkpoint and prompt-history files. Found by
 *  scanning /proc rather than a lock file, so it also catches processes
 *  started by builds that never wrote one. Linux only; elsewhere returns []. */
export function findOtherInstances(projectRoot: string, selfPid: number, selfScript: string): number[] {
  if (process.platform !== "linux") return [];
  const self = realpathOrNull(selfScript);
  if (!self) return [];
  const root = realpathOrNull(projectRoot) ?? projectRoot;
  const found: number[] = [];
  // Ancestors of `self` share the same project dir and often run the same
  // script (e.g. the parent that launched us, or a shared agent/IDE host), so
  // they look like sibling instances but aren't — skipping them avoids the
  // "already running" false positive on our own session tree. Descendants are
  // already excluded by `pid === selfPid`'s intent plus this ancestor walk.
  const ancestors = collectAncestors(selfPid);
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid || ancestors.has(pid)) continue;
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== root) continue;
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.slice(1).some((arg) => arg && realpathOrNull(arg) === self)) found.push(pid);
    } catch {
      // exited meanwhile, or not ours to inspect
    }
  }
  return found;
}

/** The chain of ancestors of `pid` (parent, grandparent, ... up to PID 1),
 *  excluding `pid` itself. Used so we don't report our own session tree as a
 *  competing instance. Reads /proc/<pid>/stat's ppid field; tolerant of races
 *  (a process that exits mid-walk just stops the walk). */
function collectAncestors(pid: number): Set<number> {
  const ancestors = new Set<number>();
  let cur: number | undefined = pid;
  let guard = 0;
  while (cur && cur !== 1 && !ancestors.has(cur) && guard++ < 64) {
    try {
      const stat: string = readFileSync(`/proc/${cur}/stat`, "utf8");
      // Field after the trailing ")"; split on whitespace, index [1] is ppid.
      const fields: string[] = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const parent: number = Number(fields[1]);
      if (!parent) break;
      ancestors.add(parent);
      cur = parent;
    } catch {
      break; // process gone or unreadable — stop the walk.
    }
  }
  return ancestors;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // An exited process its parent hasn't reaped yet (a zombie) still
  // answers signal 0, but it's gone for our purposes.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** SIGTERM (the old process's handler restores its terminal and exits),
 *  then SIGKILL if it's still around after `graceMs`. Resolves true once
 *  the process is gone. */
export async function terminateInstance(pid: number, graceMs = 5000): Promise<boolean> {
  const waitGone = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !isAlive(pid);
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }
  if (await waitGone(graceMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  return waitGone(2000);
}

/**
 * 이 포트를 **이미 다른 프로세스가** 들고 있는가.
 *
 * 왜 락 파일로 충분하지 않은가: 락은 **자기 pid** 를 적는다. 그런데 이전 실행이
 * 크래시하면서 락만 지우고(또는 내가 락의 pid 를 잘못 읽어서) 포트는 살아남는 경우,
 * 락은 "없음" 이라고 말하고 포트는 "있음" 이라고 말한다(실측: 락이 243097 이었는데
 * 7317 의 소유자는 185924 였다 — 그 서버를 못 죽여 **옛 코드로 측정**했다).
 *
 * **포트가 이미 차 있는 채로 부팅하면, 그 프로세스가 응답하는 동안 우리는 아무것도
 * 하지 않는다.** 그래서 부팅 시점에 확인하고, 있으면 **왜인지와 누구인지** 를 말한다
 * (조용히 넘기면 사용자는 옛 서버가 자기 창을 계속 조작하는 걸 본다).
 *
 * 판정 정본은 **포트** 다(§④ 표 21 — 프로세스 이름은 위장된다).
 */
export function portOwner(pid: number): { host: string; port: number } | null {
  try {
    const hex = pid.toString(16).toUpperCase().padStart(4, "0");
    const inodes = readdirSync(`/proc/${pid}/fd`)
      .map((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          return "";
        }
      })
      .filter((t) => t.startsWith("socket:["))
      .map((t) => Number(t.slice(8, -1)));
    if (!inodes.length) return null;
    // /proc/net/tcp 의 로컬 주소는 `HEXIP:HEXPORT` 형태다.
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(1)) {
        const cells = line.trim().split(/\s+/);
        if (cells.length < 10) continue;
        if (!inodes.includes(Number(cells[9]))) continue;
        const [addr, portHex] = cells[1].split(":");
        const host = addr.length === 8 ? hexToIp(addr) : hexToIp6(addr);
        if (host) return { host, port: parseInt(portHex, 16) };
      }
    }
    return null;
  } catch {
    // /proc 를 못 읽으면 **모른다** — 강제로 종료하지 않는다(§5.10).
    return null;
  }
}

function hexToIp(hex: string): string | null {
  const b = hex.match(/../g)?.reverse().map((h) => parseInt(h, 16));
  return b && b.length === 4 ? b.join(".") : null;
}

function hexToIp6(hex: string): string | null {
  if (hex.length !== 32) return null;
  const groups = hex.match(/.{4}/g) ?? [];
  return groups.map((g) => parseInt(g, 16).toString(16)).join(":");
}
