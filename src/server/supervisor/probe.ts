/**
 * 감시기용 기동 프로브 — **우리가 띄운 자식** 의 hello 만 인정한다 (P13·M10·M12).
 *
 * 왜 파일+시각 두 가지를 보나: IDE 포트는 잘 알려진 값(기본 7317)이라
 * 그 포트에 누가 있더라도 그게 우리 자식이라는 보장이 없다. 예전에 같은 실수를 했다 —
 * "비어 있다고 확인한 포트" 를 두드려 두 번째 서버를 띄운 OOM 사고(§④ 29).
 * 그래서 감시기가 준 포트 파일의 포트만 두드리고, `/api/health` 의 `startedAt` 이
 * **이번 스폰 이후** 인 것만 인정한다. 낡은 서버·남의 서버는 조용히 아니라고 한다.
 */

export interface SupervisedProbeDeps {
  /** 감시기가 준 포트 파일 읽기 — 자식이 기동 후 포트를 적는다. */
  readPortFile: () => Promise<number | null>;
  /** `GET /api/health` — `{ ok, startedAt }` 모양이어야 한다. */
  fetchHealth: (port: number) => Promise<{ ok?: unknown; startedAt?: unknown } | null>;
  /** 이번 시도 스폰 시각(epoch ms). 자식의 기동 시각은 이것보다 늦어야 한다. */
  spawnStartedAt: number;
  /** 시각 허용 오차(ms). 같은 시계라 작게 둔다. 기본 1000. */
  toleranceMs?: number;
}

export async function supervisedHello(deps: SupervisedProbeDeps): Promise<boolean> {
  let port: number | null;
  try {
    port = await deps.readPortFile();
  } catch {
    return false;
  }
  if (port === null || !Number.isInteger(port)) return false;
  let health: { ok?: unknown; startedAt?: unknown } | null;
  try {
    health = await deps.fetchHealth(port);
  } catch {
    return false;
  }
  if (!health || health.ok !== true) return false;
  if (typeof health.startedAt !== "number" || !Number.isFinite(health.startedAt)) return false;
  return health.startedAt >= deps.spawnStartedAt - (deps.toleranceMs ?? 1000);
}
