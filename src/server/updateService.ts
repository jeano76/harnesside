/**
 * 업데이트 서비스 (§5.13.1 · §9.1 · P13) — GitHub Releases 와 **실제로** 통신한다.
 *
 * `pipeline.ts` 는 단계·슬롯·롤백·가드 판단을 **순수하게** 계산한다(테스트 통과).
 * `manifest.ts` 는 **검증 단위와 교체 단위를 같게** 만든다(R-5).
 * 여기는 그 계산에 필요한 **입력** 을 얻고, 단계를 순서대로 **실행** 한다.
 *
 * 이 파일이 지키는 것 — 네 가지:
 *  1. **적용은 되돌릴 수 없으면 막는다.** `planApply` 의 결정을 그대로 따른다.
 *  2. **각 단계의 성공을 따로 말한다.** "설치 성공 = 성공" 함정(§5.13.1)이 여기서
 *     끝나면 안 된다 — 부팅 확인 없이 성공으로 보고하지 않는다.
 *  3. **네트워크를 못 쓰면 조용히 통과하지 않는다.** 확인 실패와 "최신" 은 다르다.
 *  4. **검증 대상과 교체 대상은 같은 것**이다(R-5). 둘이 다르면 그 차이는
 *     "부팅은 성공하는데 옛 로직으로 도는" 조용한 실패가 된다.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readBuildInfo } from "./buildInfo.js";
import { extractZip } from "../setup/zip.js";
import { checkDependencies, makeResolver, type DepsResult } from "./update/deps.js";
import { computeTreeSha, fsVerifyIo, parseManifest, sha256, verifyDetail, verifyTree, type ReleaseManifest } from "./update/manifest.js";
import {
  DEFAULT_ROLLBACK,
  isNewer,
  judgeBoot,
  parseVersion,
  planApply,
  rollbackReason,
  verifyHash,
  VERSION_SLOTS,
  type ApplyGuard,
  type ApplyDecision,
  type LocalVersion,
  type ReleaseInfo,
  type UpdateChannel,
  type UpdatePhase,
  type BootVerdict,
  type RollbackPolicy,
} from "./update/pipeline.js";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

/** 배포물(포터블 zip) 안에서 매니페스트가 사는 경로. 트리 해시 계산에서는 **제외**한다. */
export const MANIFEST_RELPATH = "portable-manifest.json";

/**
 * 배포는 **포터블 zip 하나**로 단일화됐다 — 설치도 업데이트도 같은 자산을 쓴다.
 *
 * 예전 셀프업데이트는 플랫폼 공통 `harnesside-dist.tar.gz`(=`dist/` 만)를 받았다.
 * 그래서 `node_modules` 는 옛 것 그대로였고(`update/deps.ts` 가 막던 문제), 설치물과
 * 업데이트물이 **서로 다른 두 배포물**이었다. 지금은 자기 `<platform>-<arch>` zip 을
 * 받아 `dist/` 와 `node_modules/` 를 **함께** 교체한다.
 *
 * 이름은 `process.platform`-`process.arch` 그대로다(`make-portable.mjs` 와 같은 규칙).
 */
export function portableAssetName(platform: string = process.platform, arch: string = process.arch): string {
  return `harnesside-portable-${platform}-${arch}.zip`;
}

/** zip 옆에 별도 자산으로 오는 매니페스트 — zip 해시(`asset.sha256`)를 담는다. */
export function portableManifestAssetName(zipName: string): string {
  return `${zipName}.manifest.json`;
}

/**
 * 설치 루트 안에서 **이 프로그램이 소유한** 범위.
 *
 * 설치 루트는 이제 패키지 루트(`dist/` 의 부모)다. 그 자리에는 사용자가 만든 것이
 * 있을 수 있다 — 설치 폴더에서 실행하면 `.harnesside/`(프로젝트 상태 · 업데이트 슬롯)가
 * 바로 거기에 생긴다. "새 트리에 없는 파일은 지운다" 를 루트 전체에 적용하면
 * **사용자 상태와 롤백 슬롯까지 지운다.** 그래서 정리·검증의 "남는 파일" 판정은
 * 아래 디렉터리 안에서만 한다. 최상위 파일(런처·package.json)은 덮어쓰기만 한다.
 */
export const MANAGED_DIRS = ["dist", "node_modules"] as const;

/** `rel`(설치 루트 기준, `/` 구분)이 소유 범위 안의 파일인가. */
export function isManagedPath(rel: string): boolean {
  return MANAGED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** Windows 에서 잠긴 파일을 비켜 둔 흔적과 쓰다 만 임시 파일 — 목록 대조에서 제외한다. */
const STALE_SUFFIXES = [".harnesside-old", ".harnesside-tmp"];
const isStale = (rel: string): boolean => STALE_SUFFIXES.some((s) => rel.endsWith(s));

export interface UpdateServiceOptions {
  /** 현재 버전(패키지 json). */
  currentVersion: string;
  channel?: UpdateChannel;
  /** 이전 버전 슬롯을 둘 디렉터리. */
  slotsDir: string;
  /** 자기자신 경로(롤백 대상). `dist/server/index.js` — 여기서 **트리 루트를** 뽑는다. */
  selfPath: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  onPhase?: (p: UpdatePhase) => void;
  onError?: (message: string) => void;
  /** 게이트 판단(planApply 에 넘길 사실들). */
  guard: () => Promise<ApplyGuard>;
  /** 직전 적용 실측(초). 저장된 값이 없으면 null — **지어내지 않는다**(R-2.1). */
  measuredApplySeconds?: () => number | null;
}

export interface UpdateStatus {
  state: string;
  current: string;
  channel: UpdateChannel;
  remote: ReleaseInfo | null;
  assets: ReleaseAsset[];
  slots: string[];
  lastError: string | null;
  lastCheckedAt: number | null;
}

export class UpdateService {
  private status: UpdateStatus;
  private slots: string[] = [];
  /** 최근 판정 — `/api/update/deps` 가 그대로 노출한다(재판정 없이). */
  private lastDeps: DepsResult | null = null;

  constructor(private opts: UpdateServiceOptions) {
    this.status = {
      state: "idle",
      current: opts.currentVersion,
      channel: opts.channel ?? "stable",
      remote: null,
      assets: [],
      slots: [],
      lastError: null,
      lastCheckedAt: null,
    };
  }

  get(): UpdateStatus {
    return { ...this.status, assets: this.status.assets.slice(), slots: this.slots.slice() };
  }

  /** 테스트가 슬롯 이름을 정하기 위해(제품 경로가 아니라 **검증 보조**). */
  setRemoteForTest(version: string): void {
    this.set({ remote: { tag: `v${version}`, version, channel: this.status.channel, publishedAt: 0, notes: "", url: "" } });
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
  }

  /**
   * 설치 트리 루트 — `selfPath`(`<루트>/dist/server/index.js`)에서 **세 단계 위** = 패키지 루트.
   *
   * 왜 이것이 필요한가(R-5): 배포물은 포터블 zip **전체**(`dist/` + `node_modules/` +
   * 런처)다. 파일 하나만 갈아끼우면 나머지는 옛 버전이다. 그래서 교체와 검증의 단위를
   * `selfPath` 가 아니라 **이 루트**로 올린다. 정리 범위는 `MANAGED_DIRS` 로 제한한다.
   *
   * 규약: `src/server/` 와 `dist/server/` 는 둘 다 패키지 루트에서 두 단계 아래라
   * 같은 계산이 맞는다.
   */
  installRoot(): string {
    return resolve(this.opts.selfPath, "..", "..", "..");
  }

  /** 이 머신이 받아야 할 zip 과 그 매니페스트 — 확인한 릴리스의 자산 목록에서 찾는다. */
  bundleAssets(): { zip: ReleaseAsset | null; manifest: ReleaseAsset | null; expected: string } {
    const expected = portableAssetName();
    const zip = this.status.assets.find((a) => a.name === expected) ?? null;
    const mName = portableManifestAssetName(expected).toLowerCase();
    const manifest = this.status.assets.find((a) => a.name.toLowerCase() === mName) ?? null;
    return { zip, manifest, expected };
  }

  /**
   * 개발 체크아웃에는 적용하지 않는다. 설치 루트가 저장소면 `dist/`·`node_modules/` 를
   * 배포물로 갈아끼우게 되고, 그건 업데이트가 아니라 작업 트리 파괴다.
   */
  private async refuseCheckout(root: string): Promise<string | null> {
    const git = await stat(join(root, ".git")).catch(() => null);
    return git ? `설치 루트가 git 체크아웃입니다(${root}) — 개발 트리에는 업데이트를 적용하지 않습니다` : null;
  }

  /**
   * 버전 하나당 **두 개의 서로 다른 트리**를 둔다. 이 둘을 같은 자리에 두면
   * 조용히 아무 일도 일어나지 않는다(실측 사고 — 아래).
   *
   *   v-<버전>/slot/tree     ← **되돌릴 곳.** 지금 돌아가는 트리의 복사본.
   *   v-<버전>/staged/tree   ← **적용할 것.** 받아서 검증을 통과한 새 트리.
   *
   * ── 왜 둘이어야 하는가 (실측) ────────────────────────────────────────────
   *
   * 처음엔 둘 다 `v-<버전>/tree` 였다. 그 결과: `stageSwap` 이
   *   1) `makeSlot()` — 지금 설치를 `v-0.2.0/tree` 에 복사(**A** 를 씀), 그리고
   *   2) `installTree(v-0.2.0/tree, installRoot)` — 방금 **A** 를 쓴 자리에 **A** 를 적용.
   * → **성공으로 보고하고 아무것도 바뀌지 않았다.** 해시도 통과하고 부팅 확인도 통과한다.
   * 검증 단계에서 트리 해시가 달라야 하는데, 교체 전후가 같으니 아무도 몰랐다.
   *
   * 이것이 §R-5 가 막으려던 **아orea 사고의 다른 얼굴**이다: 조용히 옛 코드로 도는 상태.
   * 그래서 **되돌릴 곳과 적용할 것은 경로부터 다르다.**
   */
  private slotDir(version: string): string {
    return join(this.opts.slotsDir, `v-${version}`);
  }

  /** 되돌릴 곳 — 교체 **전**의 설치 트리 복사본. */
  private slotTree(version: string): string {
    return join(this.slotDir(version), "slot", "tree");
  }

  /** 적용할 것 — 다운로드 후 **검증을 통과한** 새 트리. */
  private stagedTree(version: string): string {
    return join(this.slotDir(version), "staged", "tree");
  }

  /**
   * 단계 보고. **진행률은 단계마다 리셋**한다 — 100% 가 "적용 완료" 처럼 보이면 안 된다
   * (`UpdatePhase` 주석이 명시한 계약이다).
   */
  private phase(state: UpdatePhase["state"], message: string, progress = 0, error?: string): void {
    this.set({ state });
    this.opts.onPhase?.({ state, progress, message, at: (this.opts.now ?? Date.now)(), error });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. 확인 (check)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GitHub Releases 조회.
   *
   * **403/429 는 "업데이트 없음" 이 아니라 "확인 못 함"** 이다 — 레이트리밋을 조용히
   * 넘어가면 사용자는 구버전인 줄 모른다(그리고 다음에도 확인하지 않는다).
   */
  async check(): Promise<UpdateStatus> {
    this.phase("checking", "GitHub Releases 를 확인합니다", 10);
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl ?? "https://api.github.com/repos/jeano76/harnesside/releases";
    try {
      const res = await f(`${base}?per_page=10`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "harnesside" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403 || res.status === 429) {
        const detail = `GitHub 이 확인을 막았습니다(HTTP ${res.status}) — 레이트리밋일 수 있습니다.`;
        this.set({ state: "idle", lastError: detail, lastCheckedAt: (this.opts.now ?? Date.now)() });
        this.phase("idle", `확인하지 못했습니다 — ${this.status.current} 을 계속 씁니다`, 0, detail);
        return this.get();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) throw new Error("GitHub 응답이 배열이 아닙니다(API 변경?)");

      const releases: ReleaseInfo[] = [];
      const assetsOf = new Map<string, ReleaseAsset[]>();
      for (const raw of list as Array<Record<string, unknown>>) {
        const tag = typeof raw?.tag_name === "string" ? raw.tag_name : "";
        if (!tag) continue;
        const version = tag.replace(/^v/, "");
        const prerelease = raw?.prerelease === true;
        const channel: UpdateChannel = prerelease ? "beta" : "stable";
        if (channel !== this.status.channel) continue; // 채널 불일치는 **버린다**(조용히 섞지 않는다)
        const published = typeof raw?.published_at === "string" ? Date.parse(raw.published_at) : 0;
        const rawAssets = Array.isArray(raw.assets) ? (raw.assets as Array<Record<string, unknown>>) : [];
        assetsOf.set(
          version,
          rawAssets
            .map((a) => ({ name: String(a?.name ?? ""), url: String(a?.browser_download_url ?? ""), size: Number(a?.size ?? 0) }))
            .filter((a) => a.name && a.url)
        );
        releases.push({
          tag,
          version,
          channel,
          publishedAt: Number.isFinite(published) ? published : 0,
          notes: typeof raw?.body === "string" ? raw.body.slice(0, 2000) : "",
          url: typeof raw?.html_url === "string" ? raw.html_url : "",
        });
      }
      // 정렬은 **버전 비교**로 한다. `published_at` 이나 문자열 정렬은 "v2" 가 "v10" 뒤에
      // 오는 사고를 만든다(사전순). **날짜는 정답에 개입하지 않는다**(Raiser R-3).
      releases.sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
      const remote = releases[0] ?? null;
      const newer = remote ? isNewer(remote.version, this.status.current) : false;
      this.set({
        remote,
        assets: remote ? assetsOf.get(remote.version) ?? [] : [],
        state: newer ? "available" : "up-to-date",
        lastCheckedAt: (this.opts.now ?? Date.now)(),
        lastError: null,
      });
      this.phase(
        newer ? "available" : "up-to-date",
        newer ? `새 버전 ${remote!.version} 있습니다 (현재 ${this.status.current})` : `최신입니다 (${this.status.current})`,
        newer ? 0 : 100
      );
      return this.get();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // **확인 실패 ≠ 최신.** 조용히 "최신" 으로 남으면 사용자는 구버전인 줄 모른다.
      this.set({ state: "idle", lastError: `확인 실패: ${detail}`, lastCheckedAt: (this.opts.now ?? Date.now)() });
      this.phase("idle", `확인 실패 — ${this.status.current} 을 계속 씁니다`, 0, detail);
      this.opts.onError?.(detail);
      return this.get();
    }
  }

  /**
   * 적용 전 확인 — **되돌릴 수 없으면 막는다**(pipeline 의 판단을 그대로 쓴다).
   *
   * ── 의존성은 **여기서** 결정한다 (Raiser R-1) ─────────────────────────────
   *
   * 처음엔 `guard()` 에 넣으라고 했다. 그러면 호출자(`index.ts`)가 그 한 줄을
   * 빠뜨리는 순간 **조용히 통과**한다 — 의존성 없는 배포물을 적용하고 사용자가
   * 부팅 실패를 본다. 정본은 하나여야 하므로 여기서 **항상** 다시 본다.
   * 호출자가 준 값은 **덮어쓴다.**
   */
  async planApply(): Promise<{ guard: ApplyGuard; decision: ApplyDecision; deps: DepsResult }> {
    const given = await this.opts.guard();
    const deps = await this.dependencies();
    const guard: ApplyGuard = { ...given, dependenciesReady: deps.ready, missingDependencies: deps.missing };
    this.lastDeps = deps;
    return { guard, decision: planApply(guard), deps };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. 의존성 (Raiser R-1 · 대안 나)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 배포물에 없는 의존을 **미리** 확인한다.
   *
   * 이게 막지 않으면: 코드는 새 버전, `node_modules` 는 옛 것(또는 없음),
   * 부팅 실패 → 롤백. **사용자는 한 번 죽는다.** (구성 → §13 Raiser R-1)
   */
  async dependencies(): Promise<DepsResult> {
    const root = this.installRoot();
    let pkg: Parameters<typeof checkDependencies>[1] = null;
    try {
      pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies?: unknown };
    } catch {
      pkg = null;
    }
    const r = checkDependencies(root, pkg, makeResolver(root));
    this.lastDeps = r;
    return r;
  }

  /** 최근 의존성 판정. 아직 판정한 적 없으면 null — **0 이나 "문제없음" 이 아니다.** */
  dependencyStatus(): DepsResult | null {
    return this.lastDeps;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. 검증 (verify) — 교체 단위와 같은 단위로 본다
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 설치된 트리를 **자기 매니페스트로** 검증한다.
   *
   * 배포물이 `dist/manifest.json` 을 함께 실어 보내기 때문에, 설치된 프로그램은
   * **자기 자신에 대한 증거를 안고 있다.** 이것이 R-1 의 "증명한다" 를 받아 주는 지점이다.
   *
   * `sha` 는 파일 하나가 아니라 **트리 해시**다(R-5.2). `entry` 파일 하나만으로는
   * 나머지가 옛 버전인 상태를 못 잡는다.
   */
  async verifyInstalled(): Promise<{
    ok: boolean;
    sha: string | null;
    manifest: ReleaseManifest | null;
    detail: string;
    /** 진입 파일만 갱신되고 나머지가 옛 버전인 **아orea 상태**(R-5 실측). */
    entryOnly: boolean | null;
    /** **어느 파일이** 틀렸는가. 이게 없으면 "실패했습니다" 만 남는다. */
    missing: string[];
    mismatched: Array<{ path: string; expected: string; actual: string }>;
    extra: string[];
  }> {
    const root = this.installRoot();
    let manifest: ReleaseManifest | null = null;
    try {
      const raw = await readFile(join(root, MANIFEST_RELPATH), "utf8");
      const p = parseManifest(raw);
      if (!p.ok) {
        return { ok: false, sha: null, manifest: null, detail: `설치된 매니페스트를 읽지 못했습니다: ${p.error}`, entryOnly: null, missing: [], mismatched: [], extra: [] };
      }
      manifest = p.manifest;
    } catch {
      return {
        ok: false,
        sha: null,
        manifest: null,
        detail: `설치된 트리에 ${MANIFEST_RELPATH} 이 없습니다 — 개발 실행이거나 포터블이 아닌 옛 설치입니다`,
        entryOnly: null,
        missing: [],
        mismatched: [],
        extra: [],
      };
    }

    const v = verifyTree(manifest, fsVerifyIo(root), root, { ignore: [MANIFEST_RELPATH], scope: (rel) => isManagedPath(rel) && !isStale(rel) });
    if (!v.ok) {
      return { ok: false, sha: null, manifest, detail: verifyDetail(v), entryOnly: null, missing: v.missing, mismatched: v.mismatched, extra: v.extra };
    }
    return { ok: true, sha: manifest.treeSha256, manifest, detail: verifyDetail(v), entryOnly: false, missing: [], mismatched: [], extra: [] };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. 다운로드 + 검증 — 트리로 만든다
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 자산 하나를 받아 크기·해시를 확인하고 **슬롯에** 쓴다.
   *
   * **검증 전에는 어떤 경로도 덮어쓰지 않는다** — 임시 파일에만 쓴다(파이프라인 원칙).
   */
  async downloadAsset(asset: ReleaseAsset, expectHash?: { algo: string; hex: string }): Promise<{ ok: boolean; path?: string; detail: string }> {
    const f = this.opts.fetchImpl ?? fetch;
    this.phase("downloading", `${asset.name} 을 받습니다`, 20);
    try {
      const res = await f(asset.url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (asset.size && buf.byteLength !== asset.size) {
        throw new Error(`크기가 다릅니다: ${buf.byteLength.toLocaleString("ko-KR")} != ${asset.size.toLocaleString("ko-KR")}`);
      }
      if (expectHash) {
        const v = verifyHash(buf, `${expectHash.algo}:${expectHash.hex}`);
        if (!v.ok) throw new Error(`해시 불일치: ${v.actual} != ${v.expected}`);
      }
      this.phase("verifying", `${asset.name} 해시 확인 완료`, 60);
      // **버전을 모르면 `unknown` 으로 두지 않는다** — 모든 미확인 자산이 한 디렉터리에
      // 쌓이고(실측: `v-unknown/harnesside.tgz`), 서로 다른 자산이 서로를 덮어쓴다.
      const label = this.status.remote?.version ?? this.status.current;
      const dir = this.slotDir(label);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${asset.name}.tmp`);
      const dest = join(dir, asset.name);
      await writeFile(tmp, buf);
      await rename(tmp, dest);
      return { ok: true, path: dest, detail: `${buf.byteLength.toLocaleString("ko-KR")} 바이트` };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.set({ lastError: detail });
      this.phase("failed", `다운로드 실패: ${detail}`, 0, detail);
      this.opts.onError?.(detail);
      return { ok: false, detail };
    }
  }

  /**
   * **배포물 하나를 통째로 준비한다** — 매니페스트를 먼저 받고, 그 매니페스트가
   * 선언한 해시로 아카이브를 대조한 뒤, 트리로 풀고 **목록까지** 확인한다.
   *
   * 순서가 규약이다(R-5.3):
   *   매니페스트 수신 → 아카이브 수신 → 아카이브 해시 대조 → 풀기 → **목록 대조**
   *
   * 해시는 "바이트가 손상되지 않았다" 만 증명한다. **어떤 파일들이 들어 있는가** 는
   * 목록으로 본다 — 해시만 보면 빠진 파일을 잡지 못하고, 그 실패는 **부팅**에서만
   * 나타난다(§R-5.1 인수 조건 3).
   */
  async downloadBundle(asset: ReleaseAsset): Promise<{
    ok: boolean;
    tree?: string;
    manifest?: ReleaseManifest;
    detail: string;
  }> {
    const f = this.opts.fetchImpl ?? fetch;

    // 0) **이 머신의 zip 만** 받는다. 다른 플랫폼 zip 은 node_modules 의 네이티브 모듈
    //    (node-pty)이 맞지 않아 교체하는 순간 부팅이 깨진다 — 받기 전에 거른다.
    const expected = portableAssetName();
    if (asset.name !== expected) {
      const detail = `이 머신(${process.platform}-${process.arch})의 배포물은 ${expected} 입니다 — ${asset.name} 은 적용할 수 없습니다.`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, detail };
    }
    // 1) 매니페스트 — 릴리스 자산 목록에서 찾는다. 없으면 **진행하지 않는다.**
    const mName = portableManifestAssetName(asset.name).toLowerCase();
    const mAsset = this.status.assets.find((a) => a.name.toLowerCase() === mName);
    if (!mAsset) {
      const detail = `릴리스에 ${portableManifestAssetName(asset.name)} 이 없습니다 — 검증할 수 없는 배포물은 적용하지 않습니다.`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, detail };
    }
    this.phase("downloading", "배포물 목록(manifest)을 받습니다", 15);
    let manifest: ReleaseManifest;
    try {
      const res = await f(mAsset.url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = parseManifest(await res.text());
      if (!p.ok) throw new Error(p.error);
      manifest = p.manifest;
      // 매니페스트가 **다른 플랫폼**을 선언하면 이름이 맞아도 쓰지 않는다(이름은 바꿀 수 있다).
      if ((manifest.platform && manifest.platform !== process.platform) || (manifest.arch && manifest.arch !== process.arch)) {
        throw new Error(`매니페스트가 ${manifest.platform}-${manifest.arch} 용입니다 (이 머신 ${process.platform}-${process.arch})`);
      }
    } catch (e) {
      const detail = `매니페스트를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, detail };
    }

    // 2) 아카이브 — **매니페스트가 선언한 해시로** 대조한다.
    this.phase("downloading", `${asset.name} 을 받습니다`, 25);
    let archivePath: string;
    try {
      const res = await f(asset.url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (asset.size && buf.byteLength !== asset.size) throw new Error(`크기가 다릅니다: ${buf.byteLength} != ${asset.size}`);
      if (!manifest.asset.sha256) throw new Error("매니페스트가 아카이브 해시를 선언하지 않았습니다 — 검증할 수 없는 자산은 쓰지 않습니다");
      const v = verifyHash(buf, `sha256:${manifest.asset.sha256}`);
      if (!v.ok) throw new Error(`아카이브 해시 불일치: 실제 ${v.actual.slice(0, 12)}… / 선언 ${v.expected.slice(0, 12)}…`);
      const label = this.status.remote?.version ?? this.status.current;
      const dir = this.slotDir(label);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${asset.name}.tmp`);
      archivePath = join(dir, asset.name);
      await writeFile(tmp, buf);
      await rename(tmp, archivePath);
    } catch (e) {
      const detail = `배포물 다운로드·검증 실패: ${e instanceof Error ? e.message : String(e)}`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, detail };
    }

    // 3) 풀기 — **아직 설치 트리에 손대지 않았다.** 슬롯 안에만 쓴다.
    this.phase("verifying", "배포물을 풉니다 (설치본은 아직 그대로입니다)", 55);
    const label = this.status.remote?.version ?? this.status.current;
    const staged = join(this.slotDir(label), "staged", "tree.new");
    try {
      await rm(staged, { recursive: true, force: true });
      await mkdir(staged, { recursive: true });
      // `strip: 1` — zip 은 최상위 `harnesside/` 하나를 감싼다(`make-portable.mjs` 계약).
      extractZip(archivePath, staged, { strip: 1 });
    } catch (e) {
      const detail = `배포물을 풀지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, detail };
    }

    // 4) **목록 대조** — 해시뿐 아니라 **무엇이 들어 있는지** 본다.
    // 여기는 **방금 푼 zip** 이라 범위 제한 없이 전부 본다 — 목록에 없는 파일이 끼어 있으면 그 자체가 실패다.
    const v = verifyTree(manifest, fsVerifyIo(staged), staged, { ignore: [MANIFEST_RELPATH] });
    if (!v.ok) {
      await rm(staged, { recursive: true, force: true });
      const detail = verifyDetail(v);
      this.set({ lastError: detail });
      this.phase("failed", `검증 실패 — 아무것도 교체하지 않았습니다. ${detail}`, 0, detail);
      this.opts.onError?.(detail);
      return { ok: false, detail };
    }

    const tree = this.stagedTree(label);
    await rm(tree, { recursive: true, force: true });
    await rename(staged, tree);
    const sha = computeTreeSha(manifest.files);
    this.phase("staged", `검증 완료 — ${v.detail} · 트리 ${sha.slice(0, 7)}…`, 100);
    return { ok: true, tree, manifest, detail: `${v.detail} · 트리 해시 ${sha.slice(0, 7)}…` };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. 슬롯과 교체 — 순서는 **여기 한 곳**에서만 정한다
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 현재 **설치 트리 전체**를 슬롯에 복사한다 — 롤백의 물건.
   *
   * 여기 없으면 되돌릴 곳이 없다 = `planApply` 가 업데이트를 **거부**한다(D14).
   *
   * 예전엔 실행 파일 **하나**를 복사했다. 그래서 `dist/agent/loop.js` 같은 나머지가
   * 슬롯에 없었고, 롤백하면 **트리 절반만 옛 버전**으로 돌아갔다. 조용히.
   */
  async makeSlot(): Promise<{ ok: boolean; detail: string }> {
    try {
      const version = this.status.remote?.version ?? this.status.current;
      const root = this.installRoot();
      const dest = this.slotTree(version);
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      // 슬롯에는 **소유 범위만** 담는다. 루트 전체를 복사하면 설치 폴더 안의
      // `.harnesside/state/update-slots`(=슬롯 자신)와 사용자 파일까지 슬롯마다 복제된다.
      const copied = await copyTree(root, dest, { filter: isOwnedRel });
      // **트리 단위로 센다**(R-5.4). 파일 수로 세면 아무도 읽을 수 없다.
      while (this.slots.length >= VERSION_SLOTS) {
        const oldest = this.slots.shift();
        if (oldest) await rm(oldest, { recursive: true, force: true }).catch(() => undefined);
      }
      this.slots.push(dest);
      this.phase("idle", `롤백 슬롯을 만들었습니다: ${dest} (${copied.written}개 파일)`);
      return { ok: true, detail: dest };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.set({ lastError: detail });
      this.phase("failed", `롤백 슬롯을 만들지 못했습니다: ${detail}`, 0, detail);
      this.opts.onError?.(detail);
      return { ok: false, detail };
    }
  }

  /**
   * 교체: **슬롯 → 트리 교체**(파일마다 tmp+rename, 실행 권한 유지, **남는 파일 삭제**).
   *
   * `apply()` 와 `/api/update/apply` 라우트가 공유한다 — 교체 순서가 두 곳에
   * 있으면 하나가 반드시 어긋난다(부록 B 6). 순서는 여기서만 정한다.
   *
   * `stagedTree` 는 슬롯 안의 **검증된 트리 디렉터리**다. 임의 경로를 받지 않는다.
   */
  async stageSwap(stagedTree: string, manifest?: ReleaseManifest | null): Promise<{ ok: boolean; slot?: string; detail: string }> {
    // ── 게이트: **교체하기 전에** 새 트리가 실제로 있는 것을 본다 ────────────────
    //
    // 이 게이트가 없으면 재앙이 난다: 경로가 틀리거나 비면 `installTree` 이
    // "새 트리에 없는 파일" 을 **전부** 지운다. 즉 **빈 입력 = 설치 트리 전체 삭제.**
    // (실측: 검증에 실패한 트리를 넘겨 이 함수를 부르면 5개 파일 중 4개가 사라졌다.
    // 슬롯은 남으므로 롤백은 되지만, **그 사이에 프로그램은 죽어 있다.**)
    //
    // 그러므로: ① 경로가 존재하고 ② **파일이 하나 이상** 있어야만 교체한다.
    // 비어 있으면 그 사실 자체를 **삭제 사유**로 말하고 아무것도 건드리지 않는다.
    if (!stagedTree) return { ok: false, detail: "교체할 트리 경로가 없습니다 — 먼저 배포물을 검증하십시오" };
    const stagedFiles = await walk(stagedTree);
    if (stagedFiles.length === 0) {
      return { ok: false, detail: `교체할 트리가 비어 있습니다: ${stagedTree} — 아무것도 교체하지 않았습니다 (빈 입력은 설치 트리 삭제가 된다)` };
    }

    // 되돌릴 곳(교체 **전**) — 교체 후에 만들면 옛 것이 이미 없다.
    // 그리고 이 슬롯은 **적용할 트리와 다른 경로**다(위 주석의 실측 사고).
    const root = this.installRoot();
    const checkout = await this.refuseCheckout(root);
    if (checkout) return { ok: false, detail: checkout };

    const slot = await this.makeSlot();
    if (!slot.ok) return { ok: false, detail: `롤백 슬롯을 만들지 못해 적용하지 않았습니다: ${slot.detail}` };

    try {
      const r = await installTree(stagedTree, root, this.opts.selfPath);
      // ── 매니페스트를 **따로** 쓴다 ─────────────────────────────────────────
      // zip 안의 매니페스트는 자기 zip 의 해시를 담을 수 없다(닭과 달걀 — `make-portable.mjs`).
      // 그래서 zip 해시까지 담은 **별도 자산**의 매니페스트를, 교체와 **같은 순간** 설치 루트에 굽는다.
      // 그때부터 이 프로그램은 **자기 매니페스트로 자기 트리를 증명**한다(§0.1).
      //
      // **왜 반드시 이 순간인가**: 매니페스트를 안 쓰면 다음 기동이 옛 매니페스트로
      // 자기 트리를 검사하고, 옛 매니페스트는 **새 트리를 통과 못 한다** →
      // 사용자는 업데이트에 성공한 뒤에도 "설치 해시: 검증 안 됨" 을 본다.
      let wrote = "";
      if (manifest) {
        const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
        const target = join(root, MANIFEST_RELPATH);
        const tmp = `${target}.harnesside-tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, target);
        wrote = ` · 매니페스트 기록 (트리 ${manifest.treeSha256.slice(0, 7)}…)`;
      }
      return { ok: true, slot: slot.detail, detail: `교체됨 — ${r.written}개 파일 교체, ${r.removed}개 파일 정리${wrote}` };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.set({ lastError: detail });
      this.phase("failed", `교체 실패: ${detail}`, 0, detail);
      return { ok: false, detail };
    }
  }

  /**
   * 되돌리기: 슬롯의 **트리 전체**를 제자리로 되돌린다.
   *
   * slotPath 를 주면 그 슬롯을, 안 주면 가장 최근 슬롯을 쓴다.
   * 슬롯 범위 밖의 경로는 거부한다 — 임의 경로 복사는 곧 임의 파일 쓰기다.
   */
  async rollback(slotPath?: string): Promise<{ ok: boolean; detail: string; path?: string }> {
    const src = slotPath ?? this.slots[this.slots.length - 1];
    if (!src) return { ok: false, detail: "되돌릴 슬롯이 없습니다 — 먼저 롤백 슬롯을 만드십시오" };
    const rel = relative(resolve(this.opts.slotsDir), resolve(src));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, detail: "슬롯 범위 밖의 경로입니다" };
    }
    try {
      const root = this.installRoot();
      const checkout = await this.refuseCheckout(root);
      if (checkout) return { ok: false, detail: checkout };
      const r = await installTree(src, root, this.opts.selfPath);
      this.set({ lastError: null });
      this.phase("idle", `이전 버전으로 되돌렸습니다: ${src} (${r.written}개 파일 복원, ${r.removed}개 정리)`);
      return { ok: true, detail: `되돌렸습니다: ${src} (${r.written}개 파일)`, path: src };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.set({ lastError: detail });
      this.phase("failed", `되돌리기 실패: ${detail}`, 0, detail);
      return { ok: false, detail };
    }
  }

  /**
   * 적용: **교체 → 부팅 확인 → 실패 시 롤백**.
   *
   * "설치 성공 = 성공" 함정(§5.13.1)이 여기서 끝나면 안 된다. 파일을 **깨끗이
   * 갈아끼운 것**과 **새 버전이 실제로 기동하는 것** 은 다른 사실이고, 둘째가 없으면
   * 사용자는 업데이트를 적용한 뒤 IDE 를 못 쓴다.
   *
   * 순서를 어기면 안 되는 이유:
   *  1. 되돌릴 곳(슬롯)이 없으면 **거부**한다 — 여기서 만들지 않는다. 교체 **전에**
   *     현재 트리를 슬롯에 복사해야 한다(교체 후에 만들면 옛 것이 이미 없다).
   *  2. 교체는 **임시 경로 → rename** 이다. 전원 차단으로 반만 남으면 다음 실행이
   *     깨진 파일을 실행한다.
   *  3. 부팅 확인은 주입된 `probeHello` 다. 판정 규칙은 `judgeBoot`(파이프라인의
   *     순수 함수)이고, 여기서 **판정을 다시 쓰지 않는다** — 두 개의 판단원이 생기면
   *     어느 쪽이 진짜인지 알 수 없다.
   *  4. 실패면 슬롯에서 되돌리고 **다시 기동**한다. 복구만 하고 띄우지 않으면
   *     사용자는 "복구됐다" 는 메시지와 함께 죽은 창을 본다.
   */
  async apply(opts: {
    /** 슬롯에 받아 **검증된 새 트리**. */
    stagedTree: string;
    /**
     * 새 트리의 매니페스트. 교체와 **같은 순간** 설치 루트에 기록된다.
     * 없으면 트리는 갔지만 **자기 증명 수단이 없는 상태**가 된다 — 그래서
     * `downloadBundle` 이 준 값을 그대로 넘긴다.
     */
    manifest?: ReleaseManifest | null;
    /** 새 프로세스가 기동했는지 — 보통 `/api/health` 응답. */
    probeHello: () => Promise<boolean>;
    /** 재기동. 주입 이유: 서버는 자기 자신을 못 띄운다(§4.4 와 같은 이유). */
    restart: () => Promise<void>;
    /** 되돌린 뒤 다시 띄울 때. 없으면 `restart` 를 쓴다. */
    restartAfterRollback?: () => Promise<void>;
    policy?: RollbackPolicy;
    now?: () => number;
    /** 기다리는 동안 100ms 간격으로 부른다 — UI 가 멈춘 것처럼 보이면 안 된다. */
    onTick?: (elapsedSec: number) => void;
  }): Promise<{
    ok: boolean;
    rolledBack: boolean;
    detail: string;
    elapsedSec: number;
    verdict: BootVerdict;
  }> {
    const now = opts.now ?? this.opts.now ?? Date.now;
    const policy = opts.policy ?? DEFAULT_ROLLBACK;
    const { decision, guard } = await this.planApply();
    if (!decision.ok) {
      // **되돌릴 곳이 없는데 진행하면 베팅이다.** (`planApply` 의 결정을 그대로 쓴다)
      return {
        ok: false,
        rolledBack: false,
        detail: `적용하지 않았습니다: ${decision.blockers.join(" / ")}`,
        elapsedSec: 0,
        verdict: "pending",
      };
    }

    // 1+2. 되돌릴 곳(교체 전) + 교체 — 순서는 stageSwap 이 정한다.
    const staged = await this.stageSwap(opts.stagedTree, opts.manifest);
    if (!staged.ok) {
      return { ok: false, rolledBack: false, detail: staged.detail, elapsedSec: 0, verdict: "pending" };
    }
    const slot = { ok: true as const, detail: staged.slot! };

    // 3. **재기동 후** 부팅 확인.
    //
    // 순서가 중요하다: 파일을 **갈아끼운 것만으로는 아무것도 바뀌지 않는다**
    // (실측: 재기동을 빼면 성공 보고만 하고 옛 프로세스가 계속 돈다 — 새 버전이
    // 실행된 적도 없다). 그래서 교체 → 재기동 → 확인 순서로 고정한다.
    //
    // **주의**: 이 메서드가 실행 중인 프로세스라면 `restart` 가 그 프로세스를 죽인다.
    // 그래야 `apply` 는 되돌리기까지 할 수 없고, 실제로는 **상위 감시기(supervisor)** 가
    // 이 일을 맡는다(§5.13.1). `restart`/`probeHello` 가 주입인 이유이고, 자기가
    // 자신을 갈아끼우면서 롤백까지 하려면 별도 프로세스가 필요하다.
    this.phase("verifying", "새 버전을 실행하고 기동을 확인합니다", 80);
    try {
      await opts.restart();
    } catch (e) {
      const detail = `재기동에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`;
      this.set({ lastError: detail });
      this.phase("failed", detail, 0, detail);
      return { ok: false, rolledBack: false, detail, elapsedSec: 0, verdict: "pending" };
    }
    const startedAt = now();
    let sentHello = false;
    let verdict: BootVerdict = "pending";
    while (true) {
      const elapsedSec = (now() - startedAt) / 1000;
      try {
        sentHello = await opts.probeHello();
      } catch {
        sentHello = false;
      }
      verdict = judgeBoot(sentHello, elapsedSec, policy);
      opts.onTick?.(Math.round(elapsedSec));
      if (verdict !== "pending") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (verdict === "healthy") {
      this.set({ lastError: null });
      // **교체한 파일과 실행된 파일은 다른 사실**이다. 새 기동이 자기 트리를
      // 스스로 확인한다 — 그 결과를 **기록으로** 남긴다(R-6.1).
      const verified = await this.verifyInstalled();
      this.phase(
        "idle",
        verified.ok
          ? `새 버전이 기동했습니다 · 트리 ${verified.sha?.slice(0, 7)}… 검증됨`
          : `새 버전이 기동했습니다 · 다만 트리 검증이 실패했습니다: ${verified.detail}`,
        100
      );
      return { ok: true, rolledBack: false, detail: verified.ok ? "새 버전이 기동 신호를 보냈고 설치 트리도 검증되었습니다" : `새 버전이 기동했지만 트리 검증 실패: ${verified.detail}`, elapsedSec: Math.round((now() - startedAt) / 1000), verdict };
    }

    // 4. 실패 — 되돌리고 **다시 띄운다** (복사는 rollback 이 정한다).
    const reason = rollbackReason(policy);
    try {
      const back = await this.rollback(slot.detail);
      if (!back.ok) throw new Error(back.detail);
      await (opts.restartAfterRollback ?? opts.restart)();
      this.set({ lastError: reason });
      this.phase("failed", reason, 0, reason);
      this.opts.onError?.(reason);
      return { ok: false, rolledBack: true, detail: reason, elapsedSec: Math.round((now() - startedAt) / 1000), verdict };
    } catch (e) {
      // **되돌리기까지 실패했다면 그 사실을 그대로 말한다.** "복구됨" 이라고 말하면
      // 사용자는 없는 파일을 실행한다. 실행 파일이 **안 된다** 는 것도 가능한 사실이다.
      const root = this.installRoot();
      const detail = `이전 버전으로 되돌리기도 실패했습니다: ${e instanceof Error ? e.message : String(e)}. 실행 파일이 ${this.opts.selfPath} 에서 실행되지 않을 수 있습니다.`;
      this.set({ lastError: detail });
      this.phase("failed", `${detail} (설치 루트: ${root})`, 0, detail);
      this.opts.onError?.(detail);
      return { ok: false, rolledBack: false, detail, elapsedSec: Math.round((now() - startedAt) / 1000), verdict };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. 로컬 설치 사실 — 추정이 아니라 측정
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 설정 화면의 "출처" 칸이 쓰는 값.
   *
   * `sha` 는 **트리 해시**이고, **자기 매니페스트로 검증한 값**이다(R-5.2).
   * 검증에 실패하면 `null` 이다 — 파일 하나의 해시를 대신 보고하지 않는다.
   * `builtAt`·`date`·`commit` 은 R-1 이 **주입한 값**이고, 없으면 `null`(개발 실행).
   */
  async local(): Promise<LocalVersion> {
    const bi = readBuildInfo();
    const verified = await this.verifyInstalled();
    return {
      version: this.status.current,
      channel: this.status.channel,
      installPath: this.opts.selfPath,
      sha: verified.ok ? verified.sha : null,
      date: bi.date,
      commit: bi.sha,
      dirty: bi.dirty,
      builtAt: bi.builtAt,
      stamped: bi.stamped,
      node: process.version,
      chrome: null,
      llama: null,
      model: null,
    };
  }

  /** 검증 결과를 사람이 읽을 한 줄로 (로그·화면 공용). */
  async describeInstalled(): Promise<string> {
    const v = await this.verifyInstalled();
    return v.detail;
  }

  /** 트리 해시 — 로컬 설치 사실. 검증 실패면 null. */
  async treeSha(): Promise<string | null> {
    const v = await this.verifyInstalled();
    return v.ok ? v.sha : null;
  }

  /** 파일 하나의 해시 — 진단용. **설치 해시로 쓰지 않는다**(R-5.2). */
  async fileSha(path: string): Promise<string | null> {
    try {
      return sha256(await readFile(path));
    } catch {
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 트리 복사 — 전부 여기 한 곳에서 (두 정본 금지, §14)
// ──────────────────────────────────────────────────────────────────────────────

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/** 설치 루트에서 이 프로그램이 소유한 파일인가 — 소유 디렉터리 안이거나 최상위 파일. */
export function isOwnedRel(rel: string): boolean {
  if (isStale(rel)) return false;
  return isManagedPath(rel) || !rel.includes("/");
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

/**
 * `tmp` 를 `to` 자리에 놓는다. Windows 에서 **실행 중인 프로세스가 로드한** 네이티브
 * 모듈(`node-pty` 의 `.node`·`.dll`)은 덮어쓸 수 없지만 **이름은 바꿀 수 있다.**
 * 그래서 막히면 옛 파일을 `.harnesside-old` 로 비켜 두고 새 파일을 놓는다 — 비켜 둔
 * 파일은 다음 교체(`installTree`)가 지운다. 다른 OS 의 실패는 그대로 던진다.
 */
async function placeFile(tmp: string, to: string): Promise<void> {
  try {
    await rename(tmp, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
    const aside = `${to}.harnesside-old`;
    await rm(aside, { force: true }).catch(() => undefined);
    await rename(to, aside);
    await rename(tmp, to);
  }
}

/**
 * 트리 복사 — **파일마다 tmp → rename**. 전원 차단으로 반만 남으면 다음 실행이
 * 깨진 파일을 실행한다.
 *
 * 심볼릭 링크는 **따라가지 않고 건너뛴다.** 링크를 따라 복사하면 슬롯이 루트 밖을
 * 삼키고, 링크를 만들면 롤백이 원본을 건드릴 위험이 있다. 포터블 zip 에는 링크가
 * 없다(`make-portable.mjs` 가 담지 않는다) — 건너뛰어도 빠지는 것은 없다.
 *
 * `skipIdentical`: 이미 같은 바이트면 쓰지 않는다. 교체에서 쓴다 — 바뀌지 않은 네이티브
 * 모듈을 건드리지 않으면 Windows 의 잠긴 파일 문제 자체가 생기지 않는다.
 */
export async function copyTree(
  src: string,
  dest: string,
  opts: { keep?: Set<string>; filter?: (rel: string) => boolean; skipIdentical?: boolean } = {}
): Promise<{ written: number; unchanged: number }> {
  const files = (await walk(src)).filter((rel) => (opts.filter ? opts.filter(rel) : true));
  const keep = opts.keep ?? new Set<string>();
  let written = 0;
  let unchanged = 0;
  for (const rel of files) {
    if (keep.has(rel)) continue;
    const from = join(src, ...rel.split("/"));
    const to = join(dest, ...rel.split("/"));
    if (opts.skipIdentical && (await sameBytes(from, to))) {
      unchanged++;
      continue;
    }
    await mkdir(join(to, ".."), { recursive: true });
    const tmp = `${to}.harnesside-tmp`;
    await writeFile(tmp, await readFile(from));
    // Windows has no POSIX mode bits: chmod is a no-op that can throw
    // ENOSYS/EPERM on some setups. Preserve modes where they exist.
    if (process.platform !== "win32") {
      try {
        await chmod(tmp, await modeOf(from));
      } catch {
        /* mode preservation is best-effort */
      }
    }
    await placeFile(tmp, to);
    written++;
  }
  return { written, unchanged };
}

async function modeOf(p: string): Promise<number> {
  try {
    const st = await stat(p);
    return st.mode & 0o777;
  } catch {
    return 0o644;
  }
}

/**
 * 설치 트리 교체 — 복사 + **새 트리에 없는 파일 삭제**(소유 범위 안에서만).
 *
 * 삭제가 핵심이다. 새 트리에 없는 옛 파일을 남겨두면 그 파일을 import 하는 경로가
 * **옛 코드로 돌아간다.** 해시는 통과하고 부팅은 성공한다. 조용히 틀어진다(R-5).
 *
 * 안전장치:
 *  1. 삭제는 `MANAGED_DIRS`(`dist/`·`node_modules/`) 안에서만 한다. 설치 루트에는
 *     사용자 상태(`.harnesside/`)와 롤백 슬롯이 있을 수 있다.
 *  2. 매니페스트(`portable-manifest.json`)는 **항상 남긴다** — "나는 무엇인가" 의 증거.
 *  3. `keepSelf`(진입 파일)는 **절대 지우지 않는다.**
 *  4. Windows 에서 비켜 둔 `.harnesside-old` 는 여기서 정리한다(아직 잠겨 있으면 다음 번에).
 */
export async function installTree(src: string, dest: string, keepSelf?: string): Promise<{ written: number; removed: number }> {
  // **삭제 전에 "새 트리" 가 실제로 뭔지 확인한다.** 아래 루프는 dest 에 없는 파일을
  // 지우는 것이고, 그 목록은 전적으로 `src` 에서 나온다. `src` 가 비면 목록이 비고
  // **소유 범위 전체가 삭제 대상이 된다.** `stageSwap` 의 게이트와 같은 조건이다.
  const incoming = await walk(src);
  if (incoming.length === 0) {
    throw new Error(`교체할 트리(${src})에 파일이 하나도 없습니다 — 삭제하지 않았습니다. 빈 입력을 교체로 받으면 설치 트리 전체가 지워집니다.`);
  }
  const copied = await copyTree(src, dest, { skipIdentical: true });
  const keep = new Set([...incoming, MANIFEST_RELPATH]);
  const after = await walk(dest);
  let removed = 0;
  for (const rel of after) {
    if (isStale(rel)) {
      await rm(join(dest, ...rel.split("/")), { force: true }).catch(() => undefined);
      continue;
    }
    if (!isManagedPath(rel) || keep.has(rel)) continue;
    if (keepSelf && resolve(dest, ...rel.split("/")) === resolve(keepSelf)) continue;
    await rm(join(dest, ...rel.split("/")), { force: true });
    removed++;
  }
  // 빈 디렉터리 정리 — 소유 디렉터리 안에서만. 사용자의 빈 폴더는 건드리지 않는다.
  for (const d of MANAGED_DIRS) await pruneEmptyDirs(join(dest, d));
  return { written: copied.written, removed };
}

async function pruneEmptyDirs(dir: string): Promise<void> {
  const walkUp = async (d: string): Promise<boolean> => {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return false;
    }
    let empty = true;
    for (const name of entries) {
      const abs = join(d, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!(await walkUp(abs))) empty = false;
      } else empty = false;
    }
    if (empty && resolve(d) !== resolve(dir)) await rm(d, { recursive: true, force: true });
    return empty;
  };
  await walkUp(dir);
}
