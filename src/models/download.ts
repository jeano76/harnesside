/**
 * 모델 다운로드 (§7.4 · P11) — **실제 HTTP** 로 받는다.
 *
 * 주의: `manage.ts` 의 상태 머신(중단/재개/검증/취소)은 이미 검증되어 있고, 이 파일은
 * 그 상태를 **실제로 움직이는 것** 만 책임진다. 판단을 여기서 다시 하지 않는다.
 *
 * 두 가지를 **명시적으로** 한다:
 *  1. **중단 후 재개를 실제로 한다.** `.part` 파일과 Range 헤더를 쓴다. 처음부터 다시
 *     받는 다운로드는 20 GB 를 유랑시키는 일이다.
 *  2. **크기를 모르면 진행률을 지어내지 않는다**(`totalBytes = 0` → progress 0).
 *     대략적인 % 로 "거의 다 왔다" 고 하는 건 사용자가 중단을 결정할 때 가장 나쁜 거짓말이다.
 *
 * 멀티 조각 병렬 다운로드(§7.4 의 N=8)는 **구현하지 않았다.** 순차 다운로드가
 * 정확하고 재개되며, 병렬은 대역폭을 먹는다. 이 상태를 UI 가 말해야 한다 — 조용히
 * "최적화됨" 처럼 말하면 안 된다.
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { newDownload, startDownload, advanceDownload, completeDownload, failDownload, cancelDownload, type DownloadItem } from "./manage.js";

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  /** 진행 상황을 알린다(WS). */
  onProgress?: (item: DownloadItem) => void;
  now?: () => number;
}

/** 진행률 문자열. **모르면 모른다고 말한다.** */
export function progressText(d: DownloadItem): string {
  if (d.totalBytes <= 0) return "크기 미상 — 진행률 계산 불가";
  return `${d.progress}% · ${format(d.receivedBytes)} / ${format(d.totalBytes)} · ${format(d.bytesPerSec)}/s`;
}

function format(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

export class ModelDownloader {
  private items = new Map<string, DownloadItem>();
  private cancelled = new Set<string>();

  constructor(private deps: DownloadDeps = {}) {}

  get(id: string): DownloadItem | undefined {
    return this.items.get(id);
  }

  all(): DownloadItem[] {
    return [...this.items.values()];
  }

  /** 취소 표시 — 진행 중인 요청이 이걸 보고 멈춘다. */
  cancel(id: string): DownloadItem | null {
    const cur = this.items.get(id);
    if (!cur) return null;
    this.cancelled.add(id);
    const next = cancelDownload(cur, (this.deps.now ?? Date.now)());
    this.items.set(id, next);
    this.deps.onProgress?.(next);
    return next;
  }

  /**
   * 내려받는다. **기존 `.part` 가 있으면 이어받는다** — 중단 후 재개가 이 파일의 존재 이유다.
   *
   * 진행률은 **실제로 쓴 바이트** 로 갱신한다. 쓰기 전에 "받는 중" 인 척하면 중단
   * 지점이 어긋나고, 재개가 잘못된 위치에서 시작한다.
   */
  async download(opts: { id: string; url: string; destPath: string; totalBytes?: number }): Promise<DownloadItem> {
    const f = this.deps.fetchImpl ?? fetch;
    const now = this.deps.now ?? Date.now;
    const { id, url, destPath } = opts;
    await mkdir(dirname(destPath), { recursive: true });
    const part = `${destPath}.part`;

    let total = opts.totalBytes ?? 0;
    let startAt = 0;
    const existing = await stat(part).catch(() => null);
    if (existing) startAt = existing.size;

    // **크기를 먼저 안다**(HEAD). Range 를 쓸지 말지가 여기서 결정된다.
    //
    // HEAD 의 `content-length` 는 **전체 크기** 다(지시한 Range 만큼이 아니다).
    // 여기에 이미 쓴 만큼을 더하면 총 크기가 실제보다 커져 "중간에 끝났습니다" 로
    // 거짓 실패한다(실측: 196,608 바이트를 다 받았는데 204,800 이 필요하다고 나왔다).
    if (total <= 0) {
      const head = await f(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
      const len = head?.ok ? Number(head.headers.get("content-length") ?? 0) : 0;
      if (Number.isFinite(len) && len > 0) total = len;
    }

    let item = this.items.get(id) ?? newDownload(id, destPath, total, now());
    item = { ...startDownload(item, now()), receivedBytes: startAt, totalBytes: total || item.totalBytes };
    this.items.set(id, item);
    this.deps.onProgress?.(item);

    const headers: Record<string, string> = {};
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;
    try {
      const res = await f(url, { headers, redirect: "follow" });
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.body) throw new Error("응답 본문이 없습니다");

      // 서버가 Range 를 무시하고 200 으로 전체를 주면 **기존 부분과 이어붙이면 안 된다**
      // (파일이 뒤섞인다). 이 경우 처음부터 다시 쓴다.
      const appending = startAt > 0 && res.status === 206;
      if (startAt > 0 && !appending) {
        // **서버가 Range 를 무시했다.** 처음부터 새로 쓰므로 이미 쓴 만큼을 총 크기에
        // 더해 둔 값을 되돌려야 한다. 안 되돌리면 "중간에 끝났습니다" 로 거짓 실패한다
        // (실측: 196,608 바이트를 다 받았는데 더 많이 필요하다고 나왔다).
        await unlink(part).catch(() => undefined);
        startAt = 0;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (Number.isFinite(len) && len > 0) total = len;
        const reset = this.items.get(id);
        if (reset) this.items.set(id, { ...reset, receivedBytes: 0, totalBytes: total || reset.totalBytes, progress: 0 });
      }

      // **한 번만 읽는다.** 스트림을 두 번 읽으면 두 번째는 즉시 비어 있고,
      // 진행률만 세는 코드만 남아 파일은 비어 있다(조용히 성공하는 사고).
      const self = this;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          const cur = self.items.get(id);
          if (cur) self.items.set(id, advanceDownload(cur, chunk.length, now()));
          void self.deps.onProgress?.(self.items.get(id)!);
          cb(null, chunk);
        },
      });
      const sink2 = createWriteStream(part, appending ? { flags: "a" } : { flags: "w" });
      const timer = setInterval(() => {
        this.deps.onProgress?.(this.items.get(id)!);
      }, 1000);
      timer.unref?.();
      try {
        await pipeline(Readable.fromWeb(res.body as never), counter, sink2);
      } finally {
        clearInterval(timer);
      }

      if (this.cancelled.has(id)) {
        // **.part 를 남긴다** — 재개하려면 이게 있어야 한다.
        this.cancelled.delete(id);
        const next = cancelDownload(this.items.get(id)!, now());
        this.items.set(id, next);
        this.deps.onProgress?.(next);
        return next;
      }

      const st = await stat(part);
      if (total > 0 && st.size < total) {
        throw new Error(`중간에 끝났습니다: ${st.size} / ${total} 바이트`);
      }
      await rename(part, destPath);
      const done = completeDownload(this.items.get(id)!, now());
      this.items.set(id, done);
      this.deps.onProgress?.(done);
      return done;
    } catch (e) {
      const failed = failDownload(this.items.get(id)!, e instanceof Error ? e.message : String(e), now());
      this.items.set(id, failed);
      this.deps.onProgress?.(failed);
      return failed;
    }
  }
}

/** 경로 결합 — 파일명만 쓰지 않는다(경로 조립은 `join` 으로 — §④ 표 19). */
export function modelPathFor(dir: string, file: string): string {
  return join(dir, file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file);
}
