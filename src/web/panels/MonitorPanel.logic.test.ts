/**
 * 모니터 패널 **로직** 테스트 (§5.5 · §10.2 "웹 순수 로직" 행).
 *
 * React 렌더링은 여기서 검증하지 않는다. 대신 패널의 성능 규칙이 Pure 함수로
 * 분리되어 있는지 확인한다 — 이 규칙들이 지켜지지 않으면 1Hz 갱신이 프레임 예산을
 * 다 태워 요구 11("애니메이션")이 실제로는 "끊김"이 된다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RING_SIZE } from "../../server/metrics.js";
import { bucket, severity, SEVERITY_COLOR, type Metrics } from "../../shared/metrics.js";

const m = (over: Partial<Metrics> = {}): Metrics =>
  ({
    at: Date.now(),
    cpu: { cores: [10, 20, 30], overall: 20 },
    mem: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3, usedBytes: 16 * 1024 ** 3, usedPct: 50, swapTotalBytes: 0, swapFreeBytes: 0 },
    gpu: { name: "RTX", utilPct: 12, tempC: 45, powerW: 120, memUsedMiB: 7278, memTotalMiB: 8192, memPct: 88.8 },
    disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 11 * 1024 ** 3, usedPct: 89 },
    llama: { rssBytes: 7278 * 1024 ** 2, threads: 16 },
    context: { usedTokens: 4096, totalTokens: 8192, pct: 50 },
    tokensPerSec: 42.5,
    ...over,
  }) as Metrics;

test("1초 갱신에서 React 리렌더는 **버킷이 바뀔 때만** — 그게 §5.5 규칙이다", () => {
  // 1Hz 로 값이 흔들린다. 이 차이가 리렌더를 유발하면 안 된다.
  assert.equal(bucket(88.831), bucket(88.834), "같은 버킷 안의 변화가 리렌더를 유발했다");
  assert.equal(bucket(88.831), bucket(88.840));
  // 버킷 경계는 넘겨야 바뀐다
  assert.notEqual(bucket(88.84), bucket(88.87));
  // 코어 히트맵은 거칠게 — 24코어가 5% 씩만 바뀌어도 충분
  // step=5 의 버킷은 2.5 폭이므로 71 과 72 는 같은 버킷, 78 은 다른 버킷이다.
  assert.equal(bucket(71, 5), bucket(72, 5), "코어 1% 변화가 리렌더를 유발했다");
  assert.notEqual(bucket(72, 5), bucket(78, 5));
});

test("버킷은 0 과 100 을 벗어나지 않는다", () => {
  assert.equal(bucket(0, 1), 0);
  assert.equal(bucket(100, 1), 100);
  assert.equal(bucket(0), 0);
  assert.equal(bucket(100), 100);
  assert.equal(bucket(50), 50);
});

test("색은 **세 단계** 뿐이다 — 점멸(blink) 상태는 없다(접근성·눈부심)", () => {
  assert.deepEqual(Object.keys(SEVERITY_COLOR).sort(), ["crit", "ok", "unknown", "warn"]);
  // 각각 서로 다른 색이다 (같은 색을 두 이름으로 두면 사용자가 구분할 수 없다)
  const vals = Object.values(SEVERITY_COLOR);
  assert.equal(new Set(vals).size, vals.length, "두 임계가 같은 색이다");
  // 계측 불가(unknown)는 정상(ok)과 **다른** 색 — "쉬는 중" 과 "모름" 은 다르다
  assert.notEqual(SEVERITY_COLOR.unknown, SEVERITY_COLOR.ok);
});

test("계측 불가(unknown)는 3단계 어디에도 들어가지 않는다", () => {
  // 0% 는 "0%" 다. 0 이 아니라 미확인이다.
  assert.equal(severity(0), "ok");
  const unknown = SEVERITY_COLOR.unknown;
  assert.ok(unknown);
  assert.notEqual(unknown, SEVERITY_COLOR.ok);
});

test("임계값이 §5.5 와 일치한다: <70 정상, 70~90 주의, >90 경고", () => {
  assert.equal(severity(69.99), "ok");
  assert.equal(severity(70), "warn");
  assert.equal(severity(90), "warn");
  assert.equal(severity(90.01), "crit");
});

test("컨텍스트 80% 는 컴팩션 임박 — 일반 임계(90)와 구분된다", () => {
  // 80~90 사이는 일반 색으로는 "주의" 다. 컴팩션 임박은 별도 신호여야 한다.
  const ctx = m({ context: { usedTokens: 6800, totalTokens: 8192, pct: 83 } });
  assert.equal(ctx.context!.pct, 83);
  assert.equal(severity(ctx.context!.pct), "warn", "일반 임계는 여기서 아직 주의");
  assert.ok(ctx.context!.pct > 80, "컴팩션 임박 신호가 발화해야 한다");
});

test("스파크라인은 120샘플(=60초 이상) 링을 쓴다", () => {
  assert.equal(RING_SIZE, 120);
});

test("GPU 없음 / 컨텍스트 없음 / llama 없음이 전부 가능 상태로 다뤄진다", () => {
  const bare = m({ gpu: null, context: null, llama: null, tokensPerSec: null });
  assert.equal(bare.gpu, null);
  assert.equal(bare.context, null);
  assert.equal(bare.llama, null);
  assert.equal(bare.tokensPerSec, null);
  // 나머지 계측은 여전히 산다 — 하나가 없으면 패널이 빈 화면이 되면 안 된다
  assert.equal(bare.cpu.overall, 20);
  assert.equal(bare.mem.usedPct, 50);
  assert.equal(bare.disk.usedPct, 89);
});

test("코어 목록이 비면(컨테이너) 빈 배열 — 0 으로 채우지 않는다", () => {
  const c = m({ cpu: { cores: [], overall: 0 } });
  assert.deepEqual(c.cpu.cores, []);
});
