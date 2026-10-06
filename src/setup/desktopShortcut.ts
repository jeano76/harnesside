/**
 * 바탕화면 바로가기 (Windows `.lnk` · Linux `.desktop`).
 *
 * ── 왜 별도 모듈인가 ─────────────────────────────────────────────────────
 * npm 전역 설치(`install:g`)는 셸 PATH에 `harnesside`를 넣지만, npm이 동작하지
 * 않는 머신(레지스트리 차단·권한·파손)에서는 압축(portable zip) 배포가 유일한
 * 경로다. 압축을 풀기만 해서는 "어디서 실행하나"가 남으므로, 설치 과정이
 * 바탕화면에 더블클릭 실행 아이콘까지 만든다. 모델·서버·튜닝은 `setup` 명령
 * (`ensureLocalStack`)이 담당하고, 여기는 그 진입점을 가리키는 아이콘만 만든다.
 *
 * ── 정직 규칙 ─────────────────────────────────────────────────────────────
 * 바로가기 대상은 실재하는 파일이어야 한다. 대상이 없으면 만들지 않고 실패를
 * 말한다 — 없는 것을 가리키는 아이콘은 장식이 아니라 거짓말이다.
 */

import { mkdir, writeFile, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ShortcutSpec {
  /** 바로가기 이름 (확장자 제외, 예: "HarnessIDE"). */
  name: string;
  /** 실행할 파일. 반드시 존재해야 한다 (검증됨). */
  target: string;
  /** 대상에 넘길 인자 (이미 따옴표 처리된 형태 그대로). */
  args: string;
  /** 시작 위치. */
  workDir: string;
  /** 아이콘 (.ico). 없으면 대상 자체의 아이콘을 쓴다. */
  iconPath?: string;
  /** 설명(툴팁). */
  description: string;
}

export interface ShortcutResult {
  ok: boolean;
  /** 만든 바로가기 경로. */
  path?: string;
  detail: string;
}

/** 데스크톱 디렉터리. Windows는 USERPROFILE\Desktop, 그 외는 ~/Desktop. */
export function desktopDir(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(home, "Desktop") : join(home, "Desktop");
}

/** 설치 루트에서 진입점(node 실행 파일 + dist/server/index.js)을 찾는다. */
export async function resolveLaunchTarget(installDir: string, nodeExe: string = process.execPath): Promise<{
  target: string;
  args: string;
  workDir: string;
} | null> {
  const entry = join(installDir, "dist", "server", "index.js");
  try {
    const st = await stat(entry);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const nodeOk = await stat(nodeExe).then((s) => s.isFile()).catch(() => false);
  if (!nodeOk) return null;
  return { target: nodeExe, args: `"${entry}"`, workDir: installDir };
}

/** 바로가기 표시 이름. */
export function shortcutFileName(spec: ShortcutSpec, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${spec.name}.lnk` : `${spec.name}.desktop`;
}

/**
 * Windows `.lnk` 생성을 위한 PowerShell 스크립트 (순수 함수 — 테스트 대상).
 *
 * WScript.Shell COM으로 만든다. `powershell -NoProfile -Command <script>`로 실행.
 * 경로는 큰따옴표 안에 넣고, 내부 큰따옴표는 백틱으로 이스케이프한다.
 */
export function windowsShortcutScript(spec: ShortcutSpec, lnkPath: string): string {
  const q = (s: string) => `"${s.replace(/"/g, "`\"")}"`;
  const lines = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut(${q(lnkPath)})`,
    `$sc.TargetPath = ${q(spec.target)}`,
    `$sc.Arguments = ${q(spec.args)}`,
    `$sc.WorkingDirectory = ${q(spec.workDir)}`,
    `$sc.Description = ${q(spec.description)}`,
    spec.iconPath ? `$sc.IconLocation = ${q(spec.iconPath)}` : `$sc.IconLocation = ${q(`${spec.target},0`)}`,
    `$sc.Save()`,
  ];
  return lines.join("; ");
}

/**
 * Linux `.desktop` 파일 본문 (순수 함수 — 테스트 대상).
 * 실행 가능 비트까지 줘야 더블클릭 실행이 된다 (runner가 chmod +x).
 */
export function linuxDesktopFile(spec: ShortcutSpec): string {
  const exec = spec.args ? `${spec.target} ${spec.args}` : spec.target;
  const icon = spec.iconPath ? `Icon=${spec.iconPath}\n` : "";
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${spec.name}\n` +
    `Comment=${spec.description}\n` +
    `Exec=${exec}\n` +
    `Path=${spec.workDir}\n` +
    `${icon}` +
    `Terminal=true\n` +
    `Categories=Development;\n`
  );
}

/** 기본 스펙: 설치 루트의 dist/server/index.js를 node로 실행. */
export async function defaultShortcutSpec(
  installDir: string,
  opts: { name?: string; iconPath?: string; nodeExe?: string } = {}
): Promise<ShortcutSpec | null> {
  const launch = await resolveLaunchTarget(installDir, opts.nodeExe ?? process.execPath);
  if (!launch) return null;
  let iconPath = opts.iconPath;
  if (iconPath) {
    const ok = await stat(iconPath).then((s) => s.isFile()).catch(() => false);
    if (!ok) iconPath = undefined; // 없는 아이콘을 가리키지 않는다
  }
  return {
    name: opts.name ?? "HarnessIDE",
    target: launch.target,
    args: launch.args,
    workDir: launch.workDir,
    ...(iconPath ? { iconPath } : {}),
    description: "HarnessIDE — 로컬 llama.cpp 코딩 에이전트",
  };
}

/**
 * 바탕화면에 바로가기를 만든다. 대상 파일이 없으면 만들지 않는다.
 * Windows에서는 powershell이 필요하고, 없으면 실패를 말한다.
 */
export async function createDesktopShortcut(
  installDir: string,
  opts: {
    name?: string;
    iconPath?: string;
    nodeExe?: string;
    home?: string;
    platform?: NodeJS.Platform;
    run?: (file: string, args: string[]) => Promise<string>;
  } = {}
): Promise<ShortcutResult> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const spec = await defaultShortcutSpec(installDir, {
    name: opts.name,
    iconPath: opts.iconPath,
    nodeExe: opts.nodeExe,
  });
  if (!spec) {
    return {
      ok: false,
      detail: `바로가기 대상이 없습니다: ${join(installDir, "dist", "server", "index.js")} — 먼저 압축을 완전히 푸십시오`,
    };
  }
  const run = opts.run ?? (async (file: string, args: string[]) => (await execFileAsync(file, args, { windowsHide: true })).stdout);

  if (platform === "win32") {
    const dir = desktopDir(home, platform);
    await mkdir(dir, { recursive: true });
    const lnkPath = join(dir, shortcutFileName(spec, platform));
    const script = windowsShortcutScript(spec, lnkPath);
    try {
      await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    } catch (err) {
      return { ok: false, detail: `바로가기 생성 실패 (powershell 필요): ${err instanceof Error ? err.message : String(err)}` };
    }
    const exists = await stat(lnkPath).then((s) => s.isFile()).catch(() => false);
    if (!exists) return { ok: false, detail: `바로가기 파일이 생기지 않았습니다: ${lnkPath}` };
    return { ok: true, path: lnkPath, detail: `바탕화면 바로가기: ${lnkPath}` };
  }

  // Linux: ~/.local/share/applications + ~/Desktop 둘 다 시도, 하나라도 되면 성공.
  const appsDir = join(home, ".local", "share", "applications");
  await mkdir(appsDir, { recursive: true });
  const body = linuxDesktopFile(spec);
  const made: string[] = [];
  for (const d of [appsDir, desktopDir(home, platform)]) {
    try {
      await mkdir(d, { recursive: true });
      const p = join(d, shortcutFileName(spec, platform));
      await writeFile(p, body, "utf8");
      try { await chmod(p, 0o755); } catch { /* best-effort */ }
      made.push(p);
    } catch { /* 다음 위치 시도 */ }
  }
  if (made.length === 0) return { ok: false, detail: "바로가기 파일을 쓰지 못했습니다" };
  return { ok: true, path: made[0], detail: `바로가기: ${made.join(", ")}` };
}
