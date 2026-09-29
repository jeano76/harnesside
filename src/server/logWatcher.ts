/**
 * 자식 프로세스 로그 tee (§5.12.1) — llama-server / Chrome / 도구 실행.
 *
 * 왜 이것이 중요하냐면(§5.12.1): **모델이 죽는 원인의 99%는 llama-server 의 로그에 있다.**
 * 그런데 데몬이라 터미널에 붙어 있을 사용자가 없다. 이 줄이 없다면 사용자는
 * "창이 안 떴습니다" 만 알 수 있고 왜인지 알 수 없다.
 *
 * 파싱 실패를 **조용히 버리지 않는다**: 줄을 통째로 raw 로 남긴다. 포맷을 모르는
 * 로그에서 "아무것도 안 보임" 은 "로그가 없음" 과 구분되지 않는다.
 */

import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { getLogRing, type LogRing, type LogSource } from "./logRing.js";

export interface TeeOptions {
  ring?: LogRing;
  source: LogSource;
  scope: string;
  /** 로그 레벨을 패턴으로 올린다 (에러로 승격). */
  errorPattern?: RegExp;
}

const DEFAULT_ERROR_PATTERN = /error|fail|fatal|oom|out of memory|abort|panic|cudaMalloc failed|traceback/i;

export interface TeeHandle {
  close: () => void;
  lines: number;
}

export function teeChild(child: ChildProcessWithoutNullStreams, opts: TeeOptions): TeeHandle {
  const ring = opts.ring ?? getLogRing();
  const pattern = opts.errorPattern ?? DEFAULT_ERROR_PATTERN;
  let lines = 0;

  const attach = (stream: "stdout" | "stderr") => {
    const src = child[stream];
    if (!src) return;
    createInterface({ input: src }).on("line", (line) => {
      lines++;
      const text = line.trimEnd();
      if (!text) return;
      const isErr = stream === "stderr" || pattern.test(text);
      // llama-server 의 로그는 사람이 읽는 문장이라 prefix 를 붙이지 않는다 —
      // 원문 그대로가 더 쓸모 있다. 그래서 scope 로만 구분한다(§3.7.1).
      if (isErr) ring.error(opts.scope, text, opts.source, { stream });
      else ring.info(opts.scope, text, opts.source, { stream });
    });
  };

  attach("stdout");
  attach("stderr");
  return { close: () => {}, lines: 0 };
}

/** 임의 텍스트(파일 등)를 링에 넣는다. */
export function teeText(text: string, opts: TeeOptions & { level?: "info" | "warn" | "error" }): number {
  const ring = opts.ring ?? getLogRing();
  let n = 0;
  for (const line of text.split("\n")) {
    const t = line.trimEnd();
    if (!t) continue;
    n++;
    const lvl = opts.level ?? (opts.errorPattern ?? DEFAULT_ERROR_PATTERN).test(t) ? "error" : "info";
    ring.append({ ts: Date.now(), level: lvl, scope: opts.scope, source: opts.source, message: t });
  }
  return n;
}
