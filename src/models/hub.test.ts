/**
 * 모델 추천 규칙 테스트 (§7.2 · §7.3) — **규칙이 지켜지는지** 를 본다.
 *
 * 여기서 검사하는 세 가지를 §7.2 가 명시했다:
 *  - 로컬에 Ornith 만 있으면 그 파일이 1순위(점수 무관)
 *  - 다른 모델만 있으면 Ornith 를 **제안**하고 "다운로드" 를 붙인다(자동 받지 않음)
 *  - 계열이 검색 결과에 없으면 **폴백 + 사유 문구**
 *
 * 그리고 §7.3 의 VRAM 규칙: 8GiB 머신에서 Q4_K_M 보다 큰 양자화를 고르지 않는다.
 *
 * 네트워크는 **두지 않는다** — 실측 Pin 의 응답을 검증하는 것이 아니라 **규칙** 을
 * 검증해야 하므로, 응답 모양을 주입한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { recommend, scoreModel, estimateMemory, parseHubSearch, expandMissingFiles, localMatchesPinned, fillSizes, pickForMachine, quantRank, type HubModel, searchHub } from "./hub.js";
import type { Hardware } from "../setup/hardware.js";

const GiB = 1024 ** 3;

function hw(freeVramGiB = 7.5): Pick<Hardware, "gpus"> {
  return { gpus: [{ index: 0, name: "Test", vramTotalBytes: 8 * GiB, vramFreeBytes: freeVramGiB * GiB }] } as unknown as Pick<
    Hardware,
    "gpus"
  >;
}

function model(over: Partial<HubModel> = {}): HubModel {
  return {
    id: "someone/Model-7B-GGUF",
    repo: "someone/Model-7B-GGUF",
    file: "someone/Model-7B-GGUF/model-Q4_K_M.gguf",
    bytes: 4 * GiB,
    downloads: 1000,
    license: "apache-2.0",
    gguf: true,
    toolCalling: true,
    thinking: false,
    ...over,
  };
}

test("우선 계열은 **점수와 무관하게** 1순위다 — 이 프로젝트의 실측값은 그 계열에서 나왔다", () => {
  // 일부러 점수가 낮게 만든 경쟁자를 둔다. 그래도 계열이 먼저 온다.
  const big = model({ id: "x/Big-70B", file: "x/Big-70B/Big-70B-Q4_K_M.gguf", bytes: 40 * GiB, license: null });
  const pin = model({ id: "z/ornith-1.5-35b-a3b-GGUF", file: "z/ornith-1.5-35b-a3b-GGUF/Ornith-1.5-35B-A3B-Q4_K_M.gguf", bytes: 20 * GiB });
  const r = recommend([big, pin], hw(7.5));
  assert.ok(r.pinned, "우선 계열이 추천 목록에서 빠졌다");
  assert.match(r.pinned!.model.id, /ornith/i);
  assert.equal(r.fallbackReason, null, "있는데 '못 찾았습니다' 고 말한다");
});

test("계열이 없으면 **점수순으로** 보여주되 **왜** 못 찾았는지 말한다", () => {
  const r = recommend([model()], hw());
  assert.equal(r.pinned, null);
  assert.ok(r.fallbackReason, "폴백 사유가 없다 — 조용히 다른 모델을 1순위로 올리는 것은 §7.2 가 금지한다");
  assert.match(r.fallbackReason!, /Ornith/);
});

test("로컬에 있는데 검색에 없으면 **다른 이유**로 말한다 — 네트워크/계정 문제다", () => {
  const r = recommend([model()], hw(), { localFiles: ["/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf"] });
  assert.match(r.fallbackReason!, /로컬/);
  assert.match(r.fallbackReason!, /계정|네트워크/);
});

test("8GiB 머신에서 VRAM 을 넘치는 모델은 **강하게 감점**된다", () => {
  // 컨텍스트 8k(그때 32k 였다면 **어떤** Q4 도 8 GiB 카드에 들어가지 않는다 —
  // KV 가 9.6 GiB 이므로. 이게 §7.3 식을 제대로 읽었을 때의 실제 결과다).
  const fits = scoreModel(model({ bytes: 4 * GiB }), hw(7.5), { contextK: 8 });
  const tooBig = scoreModel(model({ id: "x/Huge", file: "x/Huge/Huge-Q4_K_M.gguf", bytes: 40 * GiB }), hw(7.5), { contextK: 8 });
  assert.ok(fits.score > tooBig.score, `들어가는 모델(${fits.score})이 안 들어가는 모델(${tooBig.score})보다 낮다`);
  assert.ok(tooBig.notes.some((n) => /VRAM/.test(n)), "감점 사유를 말하지 않는다 — '왜 저점이지?' 에 답이 없다");
});

test("32k 컨텍스트에서 8GiB 카드엔 **아무것도** 들어가지 않는다고 말한다", () => {
  // 이건 제품 결정이다: 조용히 점수를 조금 낮춰 "방금 들어갑니다" 처럼 하지 않는다.
  const s = scoreModel(model({ bytes: 4 * GiB }), hw(7.5), { contextK: 32 });
  assert.ok(s.notes.some((n) => /VRAM/.test(n)), "부족한데 감점 사유를 남기지 않는다");
});

test("점수는 **0~100** 을 넘지 않는다 — 큰 감점이 음수가 되지 않는다", () => {
  const s = scoreModel(model({ bytes: 500 * GiB, downloads: 0, license: "weird-license" }), hw(0.5));
  assert.ok(s.score >= 0 && s.score <= 100, `점수가 범위를 벗어났다: ${s.score}`);
});

test("같은 계열에서는 **이 머신에 들어가는 파일** 을 고른다 — 76GB BF16 을 8GiB 카드에 추천하지 않는다", () => {
  // 실측: 이전 버전이 "가장 큰 파일" 을 골라 BF16(75.8 GiB) 을 1순위로 올렸다.
  const files = [
    { bytes: 4 * GiB, quant: "Q4_K_M" },
    { bytes: 6 * GiB, quant: "Q8_0" },
    { bytes: 76 * GiB, quant: "BF16" },
  ];
  const get = (f: { bytes: number; quant: string }) => f;
  // 여유 20GiB: Q4·Q8 은 들어가고 BF16 은 안 들어간다. **들어가는 것 중 가장 큰 것** = Q8_0.
  const fits = pickForMachine(files, 20, get);
  assert.equal(fits.pick?.quant, "Q8_0", `들어갈 수 있는 것을 고르지 않았다: ${fits.pick?.quant}`);
  assert.match(fits.reason, /들어가는/);
  // **어떤 것도 안 들어가면** 가장 작은 것을 고르되 **그 사실을 말한다**.
  const none = pickForMachine(files, 7.5, get);
  assert.equal(none.pick?.quant, "Q4_K_M", "가장 작은 것을 고르지 않았다");
  assert.match(none.reason, /들어가지 않습니다/, "안 들어간다고 말하지 않는다");
  // 크기를 모르면 가장 작은 양자화를 고르고 **모른다고** 말한다.
  const unknown = pickForMachine([{ bytes: 0, quant: "BF16" }, { bytes: 0, quant: "Q4_K_M" }], 7.5, get);
  assert.equal(unknown.pick?.quant, "Q4_K_M");
  assert.match(unknown.reason, /크기를 확인하지 못/);
});

test("모르는 양자화는 순서를 **매기지 않는다** — 0 은 '맨 작음' 이라는 뜻이 아니다", () => {
  assert.equal(quantRank("Q4_K_M"), 6);
  assert.equal(quantRank("모르는 양자"), null);
  assert.equal(quantRank(null), null);
});

test("추천은 **상위 5개** 다 — 더 많이 보여주면 무엇을 골라야 하는지 모른다", () => {
  const many = Array.from({ length: 9 }, (_, i) => model({ id: `x/M${i}`, file: `x/M${i}/M${i}-Q4_K_M.gguf` }));
  const r = recommend(many, hw());
  assert.equal(r.top.length, 5);
});

test("속도는 **지어내지 않는다** — 추정치를 숫자로 보여주면 사용자가 시간을 낭비한다", () => {
  const s = scoreModel(model(), hw());
  assert.equal(s.estimate.tokensPerSec, null, "측정 없이 tok/s 를 댔다");
  assert.match(s.estimate.why, /추정/);
});

test("크기 추정치는 KV 를 더한다 — 가중치만 보면 컨텍스트가 안 들어가므로 틀린다", () => {
  const e = estimateMemory(4 * GiB, 32);
  assert.ok(e.vramGiB > 4, "KV 를 더하지 않았다");
  // 32k × 0.3 GiB = 9.6 GiB. (0.3 × 32/1024 로 읽으면 9.6 MiB 가 되어 1000배 틀린다 —
  // 실제로 그렇게 읽어서 "충분히 들어간다" 는 잘못된 추천이 나왔다.)
  assert.match(e.vramGiB.toFixed(1), /^13\.6/, `예상값 ${e.vramGiB}`);
});

test("HF 응답에서 **모르는 모양은 버린다** — 없는 모델을 제안하지 않는다", () => {
  const out = parseHubSearch([{ id: "a/b" }, { nope: 1 }, "문자열", null]);
  // `siblings` 가 없는 항목은 **제외** 된다. 지어낸 파일 이름은 404 다(실측).
  assert.equal(out.length, 0, "파일을 모르는 모델을 추천했다");
  const withFiles = parseHubSearch([{ id: "a/b", siblings: [{ rfilename: "m-Q4_K_M.gguf" }] }]);
  assert.equal(withFiles.length, 1);
  assert.equal(withFiles[0].file, "a/b/m-Q4_K_M.gguf");
  assert.equal(withFiles[0].bytes, 0, "목록 API 에는 크기가 없다 — 0 이 아니라 '모름'");
});

test("파일 목록이 없으면 **저장소를 한 번 더 물어본다** — 그리고 적게", async () => {
  const asked: string[] = [];
  const f = (async (u: RequestInfo | URL) => {
    asked.push(String(u));
    if (String(u).endsWith("/api/models/x/has")) {
      return { ok: true, json: async () => ({ id: "x/has", siblings: [{ rfilename: "m.gguf" }] }) } as unknown as Response;
    }
    return { ok: true, json: async () => [{ id: "x/has" }] } as unknown as Response;
  }) as unknown as typeof fetch;
  const out = await expandMissingFiles([{ id: "x/has" }], { fetchImpl: f, baseUrl: "http://h" });
  assert.equal(out.length, 1, "확장 후에도 파일이 없다");
  assert.equal(out[0].file, "x/has/m.gguf");
  assert.ok(asked.some((u) => u.endsWith("/api/models/x/has")), "저장소를 다시 묻지 않았다");
});

test("우선 계열은 **상위 5개 슬롯에 올라가지 않는다** — 계열끼리 경쟁하면 안 된다", () => {
  // §7.2: "계열은 이 5개 슬롯에 서로 경쟁시키지 않는다. 항상 별도 고정 배너로."
  // 고른 **하나만** 빼면 같은 계열의 나머지가 슬롯을 차지한다(실측: 9B·1.0 이 top 에 있었다).
  const many = Array.from({ length: 4 }, (_, i) =>
    model({ id: `ornith-ai/Ornith-1.5-35B-A3B-GGUF-v${i}`, file: `ornith-ai/Ornith-1.5-35B-A3B-GGUF-v${i}/m-Q4_K_M.gguf` })
  );
  const r = recommend(many, hw());
  assert.equal(r.top.length, 0, `계열이 슬롯을 차지했다: ${r.top.map((t) => t.model.id).join(", ")}`);
  assert.ok(r.pinned, "고정 배너에 들어갈 하나는 있어야 한다");
});

test("크기를 모르면 점수를 **지어내지 않는다** — 다 100점 이면 비교가 아니다", () => {
  const unknown = scoreModel(model({ bytes: 0 }), hw());
  assert.ok(unknown.notes.some((n) => /크기/.test(n)), "크기를 모른다고 말하지 않는다");
  assert.equal(unknown.estimate.why.includes("추정 불가"), true);
  // 100점이 아니라 **0(미산정)** 다. 100점을 주면 "비교가 됐다" 고 읽힌다(실측).
  assert.equal(unknown.score, 0, `미산정인데 점수가 ${unknown.score} 로 나왔다`);
  // 알 수 있는 것은 **순위** 다 — 순서를 Downloads 로 매긴다.
  const a = model({ id: "a/x", file: "a/x/m.gguf", bytes: 0, downloads: 10 });
  const b = model({ id: "b/x", file: "b/x/m.gguf", bytes: 0, downloads: 900 });
  const r = recommend([a, b], hw());
  assert.equal(r.top[0].model.id, "b/x", "알려진 사실(다운로드 수)으로도 순위를 매기지 않았다");
});

test("크기 채우기는 **적게** 요청한다 — 마크를 아끼는 사용자다", async () => {
  const asked: string[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(u));
    if (init?.method === "HEAD") return { ok: true, headers: new Headers({ "content-length": "12345" }) } as unknown as Response;
    // 저장소 트리는 **404** 다 — 그래야 개별 조회로 내려가는 경로를 재게 된다.
    return { ok: false, status: 404, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;
  const models = Array.from({ length: 20 }, (_, i) => model({ id: `x/M${i}`, file: `x/M${i}/M${i}.gguf`, bytes: 0 }));
  const r = await fillSizes(models, { fetchImpl: f, headLimit: 5 });
  const heads = asked.filter((u) => u.includes("/resolve/"));
  assert.equal(heads.length, 5, `HEAD 를 ${heads.length} 번 보냈다 — 5개로 제한해야 한다`);
  assert.ok(
    heads.every((u) => u.split("/").filter((s) => s.startsWith("M") && s.endsWith(".gguf")).length === 1),
    `저장소가 두 번 들어갔다: ${heads[0]}`,
  );
  assert.equal(r.models[0].bytes, 12345, "크기를 채우지 못했다");
  assert.equal(r.models[19].bytes, 0, "요청하지 않은 항목은 '모름' 그대로");
});

test("저장소 트리 **한 번** 으로 그 저장소의 모든 크기를 채운다 — 후보 수와 무관하다", async () => {
  // 실측 근거: `/api/models/{repo}/tree/main?recursive=true` 는 31개 gguf 의 크기를
  // 10 KB 응답으로 한 번에 준다. 그래서 예전의 "후보 12개로 자른다" 는 근거가 사라졌다.
  const asked: string[] = [];
  const f = (async (u: RequestInfo | URL) => {
    asked.push(String(u));
    if (String(u).includes("/tree/")) {
      return {
        ok: true,
        json: async () => [
          { type: "file", path: "M-Q4_K_M.gguf", size: 100 },
          { type: "file", path: "M-Q8_0.gguf", lfs: { size: 200 } },
          { type: "file", path: "README.md", size: 10 },
        ],
      } as unknown as Response;
    }
    throw new Error(`트리 외 요청은 없어야 한다: ${String(u)}`);
  }) as unknown as typeof fetch;
  // 50개 후보, 저장소는 하나. **`repo` 와 `file` 이 일치해야** 트리 키가 맞는다 —
  // 둘이 어긋나면 조용히 개별 조회로 내려가고(요청 12번), 사용자는 "왜 느리지?" 만 본다.
  const models = Array.from({ length: 50 }, () =>
    model({ id: "x/Repo", repo: "x/Repo", file: `x/Repo/M-Q4_K_M.gguf`, bytes: 0 }),
  );
  const r = await fillSizes(models, { fetchImpl: f });
  assert.equal(asked.length, 1, `저장소 하나인데 요청이 ${asked.length} 번 — 1 이어야 한다`);
  assert.ok(asked[0].includes("/api/models/x/Repo/tree/main"), `트리 엔드포인트가 아니다: ${asked[0]}`);
  // **LFS 파일은 lfs.size 가 정본** 이다(일반 `size` 는 LFS 포인터의 크기일 수 있다).
  assert.equal(r.models[0].bytes, 100, "일반 파일 크기를 못 읽었다");
  assert.equal(r.fromTree, 50, `트리에서 채운 개수 ${r.fromTree}`);
  assert.deepEqual(r.unknown, [], "전부 채워졌는데 '모름' 이 남았다");
});

test("크기를 모르는 후보는 **점수 0(미산정)** — 순위는 다운로드 수로 매긴다", async () => {
  // 트리·HEAD 모두 실패하는 저장소.
  const f = (async () => ({ ok: false, status: 500, json: async () => [] })) as unknown as typeof fetch;
  const r = await fillSizes([model({ bytes: 0, id: "a/x" }), model({ bytes: 0, id: "b/y" })], { fetchImpl: f });
  assert.equal(r.unknown.length, 2, `모르는 후보가 ${r.unknown.length} 개`);
  assert.equal(r.models.every((m) => m.bytes === 0), true, "모름을 지어내지 않았다");
});

test("로컬 파일 판정 — **쓸 수 있는** 파일만 우선 계열로 인정한다", () => {
  assert.equal(localMatchesPinned("/m/Ornith-1.5-35B-A3B-Q4_K_M.gguf"), true);
  assert.equal(localMatchesPinned("/m/ornith-1.5-35b-a3b-q3.gguf"), true);
  assert.equal(localMatchesPinned("/m/readme.md"), false);
  assert.equal(localMatchesPinned("/m/Other-7B.gguf"), false);
});

test("tool_calling 지원 여부를 알 수 없으면 **모름** 이라고 둔다 — 가산점은 '있음' 일 때만", () => {
  const unknown = scoreModel(model({ toolCalling: null }), hw());
  const yes = scoreModel(model({ toolCalling: true }), hw());
  assert.ok(yes.score > unknown.score, "알 수 없는데 지원한다고 점수를 받았다");
});

test("`repo` 와 `file` 이 어긋나면 **조용히 개별 조회** 로 내려간다 — 그래도 죽지 않는다", async () => {
  // 목록 API 가 준 값이 서로 어긋나는 상황(가산 필터·미러)을 그대로 통과시키는 경우다.
  const asked: string[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(u));
    if (String(u).includes("/tree/")) return { ok: true, json: async () => [{ path: "M-Q4_K_M.gguf", size: 777 }] } as unknown as Response;
    if (init?.method === "HEAD") return { ok: true, headers: new Headers({ "content-length": "555" }) } as unknown as Response;
    return { ok: false, status: 404, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;
  // repo 는 A 인데 file 은 B 를 가리킨다 — 어긋난 상태.
  const r = await fillSizes([model({ id: "b/Repo", repo: "a/Repo", file: "b/Repo/M-Q4_K_M.gguf", bytes: 0 })], { fetchImpl: f });
  assert.equal(r.models[0].bytes, 555, "어긋났을 때 개별 조회로도 크기를 못 채웠다");
  assert.ok(asked.some((u) => u.includes("/resolve/")), "어긋나면 개별 조회로 내려가지 않았다");
});

test("검색 결과에서 **mmproj·vocab·중단된 다운로드** 를 뺀다 — '모델' 이 아니다", async () => {
  // 실측: .gguf 여부만 보면 상위 2개가 `mmproj-*.gguf` 였다. mmproj 는 비전 투영기이고
  // `-vocab.gguf` 는 토크나이저 조각, `.part` 는 **중단된 다운로드의 잔해** 다.
  // 사용자는 이것을 다운로드한 뒤 "이건 뭐지" 를 하게 된다.
  const json = [
    {
      id: "ornith-ai/Ornith-1.5-9B-GGUF",
      downloads: 100,
      siblings: [
        { rfilename: "Ornith-1.5-9B-Q4_K_M.gguf" },
        { rfilename: "mmproj-8B-f16.gguf" },
        { rfilename: "Ornith-vocab.gguf" },
        { rfilename: "Ornith-Q4_K_M.gguf.part" },
        { rfilename: "README.md" },
      ],
    },
  ];
  const f = (async () => ({ ok: true, json: async () => json })) as unknown as typeof fetch;
  const out = await searchHub({ query: "Ornith", fetchImpl: f });
  assert.deepEqual(
    out.map((m) => m.file.split("/").pop()),
    ["Ornith-1.5-9B-Q4_K_M.gguf"],
    `추천에 쓰레기가 섞였다: ${out.map((m) => m.file).join(", ")}`,
  );
});
