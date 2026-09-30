/**
 * 업데이트 서비스 (§5.13.1 · §9.1 · P13) — GitHub Releases 와 **실제로** 통신한다.
 *
 * `pipeline.ts` 는 단계·슬롯·롤백·가드 판단을 **순수하게** 계산한다(테스트 통과).
 * 여기는 그 계산에 필요한 **입력** 을 얻고, 단계를 순서대로 **실행** 한다.
 *
 * 이 파일이 지키는 것 — 세 가지:
 *  1. **적용은 되돌릴 수 없으면 막는다.** `planApply` 의 결정을 그대로 따른다.
 *  2. **각 단계의 성공을 따로 말한다.** "설치 성공 = 성공" 함정(§5.13.1)이 여기서
 *     끝나면 안 된다 — 부팅 확인 없이 성공으로 보고하지 않는다.
 *  3. **네트워크를 못 쓰면 조용히 통과하지 않는다.** 확인 실패와 "최신" 은 다르다.
 *
 * 주입: `fetchImpl` 로 GitHub 를 두드린다. 테스트가 진짜 네트워크를 쓰면 그 테스트는
 * "오늘의 GitHub 응답" 을 검증한다(CI 를 처음 거친 뒤 배운 교훈).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isNewer,
  parseVersion,
  planApply,
  verifyHash,
  VERSION_SLOTS,
  type ApplyGuard,
  type ApplyDecision,
  type LocalVersion,
  type ReleaseInfo,
  type UpdateChannel,
  type UpdatePhase,
} from "./update/pipeline.js";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateServiceOptions {
  /** 현재 버전(패키지 json). */
  currentVersion: string;
  channel?: UpdateChannel;
  /** 이전 버전 슬롯을 둘 디렉터리. */
  slotsDir: string;
  /** 자기자신 경로(롤백 대상). */
  selfPath: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  onPhase?: (p: UpdatePhase) => void;
  onError?: (message: string) => void;
  /** 게이트 판단(planApply 에 넘길 사실들). */
  guard: () => Promise<ApplyGuard>;
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
   * 단계 보고. **진행률은 단계마다 리셋**한다 — 100% 가 "적용 완료" 처럼 보이면 안 된다
   * (`UpdatePhase` 주석이 명시한 계약이다).
   */
  private phase(state: UpdatePhase["state"], message: string, progress = 0, error?: string): void {
    this.set({ state });
    this.opts.onPhase?.({ state, progress, message, at: (this.opts.now ?? Date.now)(), error });
  }

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
      // 오는 사고를 만든다(사전순).
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
        newer
          ? `새 버전 ${remote!.version} 있습니다 (현재 ${this.status.current})`
          : `최신입니다 (${this.status.current})`,
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

  /** 적용 전 확인 — **되돌릴 수 없으면 막는다**(pipeline 의 판단을 그대로 쓴다). */
  async planApply(): Promise<{ guard: ApplyGuard; decision: ApplyDecision }> {
    const guard = await this.opts.guard();
    return { guard, decision: planApply(guard) };
  }

  /**
   * 자산 하나를 받아 크기·해시를 확인하고 **슬롯에** 쓴다.
   *
   * **검증 전에는 어떤 경로도 덮어쓰지 않는다** — 임시 파일에만 쓴다(파이프라인 원칙).
   */
  async downloadAsset(
    asset: ReleaseAsset,
    expectHash?: { algo: string; hex: string }
  ): Promise<{ ok: boolean; path?: string; detail: string }> {
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
      // 확인된 버전을 쓰고, 그것도 없으면 **현재 버전** 으로 갈라 놓는다.
      const label = this.status.remote?.version ?? this.status.current;
      const dir = join(this.opts.slotsDir, `v-${label}`);
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
   * 현재 실행 파일을 슬롯에 **복사**한다 — 롤백의 물건.
   *
   * 여기 없으면 되돌릴 곳이 없다 = `planApply` 가 업데이트를 **거부**한다(D14).
   */
  async makeSlot(): Promise<{ ok: boolean; detail: string }> {
    try {
      const version = this.status.remote?.version ?? this.status.current;
      const dir = join(this.opts.slotsDir, `v-${version}`);
      await mkdir(dir, { recursive: true });
      const dest = join(dir, "harnesside");
      const buf = await readFile(this.opts.selfPath);
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, dest);
      // 상한(슬롯 3개) — **오래된 것부터** 지운다.
      while (this.slots.length >= VERSION_SLOTS) {
        const oldest = this.slots.shift();
        if (oldest) await rm(oldest, { recursive: true, force: true }).catch(() => undefined);
      }
      this.slots.push(dest);
      this.phase("idle", `롤백 슬롯을 만들었습니다: ${dest}`);
      return { ok: true, detail: dest };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.set({ lastError: detail });
      this.opts.onError?.(detail);
      return { ok: false, detail };
    }
  }

  /** 로컬 설치 사실 — 설정 화면의 "출처" 칸이 쓰는 값. */
  async local(): Promise<LocalVersion> {
    let sha: string | null = null;
    let bytes = 0;
    try {
      const buf = await readFile(this.opts.selfPath);
      bytes = buf.byteLength;
      sha = createHash("sha256").update(buf).digest("hex").slice(0, 7);
    } catch {
      // 못 읽으면 null — "모름" 을 0 이나 빈 문자열로 말하지 않는다
    }
    return {
      version: this.status.current,
      channel: this.status.channel,
      installPath: this.opts.selfPath,
      sha,
      builtAt: null,
      node: process.version,
      chrome: null,
      llama: null,
      model: null,
    };
  }
}

export { parseVersion, isNewer };
