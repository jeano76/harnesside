/**
 * 부팅 스모크 테스트용 **가짜 llama-server** (§10.6).
 *
 * 왜 이게 필요한가: 실제 모델이 20 GB 라서 CI 에서 받을 수 없다. 그런데 부팅 경로
 * (12단계, 포트 계획, 헬스체크, adopt) 를 검증하지 않으면 **데몬이 뜨지 않는 회귀** 를
 * 아무도 못 잡는다. 그래서 가짜를 쓴다.
 *
 * **검증하는 것과 검증하지 않는 것**를 분명히 한다:
 *  - 검증: 12단계 순서 · 포트 계획 · 헬스체크 재시도 · TTY 없는 기동 · 로그 프로토콜
 *  - 검증 **안** 함: 모델 품질 · GPU 사용률 · 토큰 정확도
 *
 * 이 파일을 통과했다고 "llama.cpp 가 동작한다" 고 말하면 안 된다.
 *
 * 사용법: `node scripts/fake-llama-server.mjs [--port 8080]`
 * 실제 llama-server 가 쓰던 최소 API 만 흉내 낸다: `/v1/models`, `/health`,
 * `/v1/chat/completions`(SSE 도 포함 — 스트리밍 경로를 살리려고).
 */

import { createServer } from "node:http";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.FAKE_LLAMA_PORT ?? 8080);

const MODELS = { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] };

const server = createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  const json = (code, body) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
    res.end(b);
  };

  if (url === "/v1/models" || url === "/models") return json(200, MODELS);
  if (url === "/health") return json(200, { status: "ok" });
  if (url === "/props" || url === "/v1/props") return json(200, { n_ctx: 16384, model_path: "/fake/model.gguf" });

  if (url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const isStream = /"stream"\s*:\s*true/.test(body);
      if (!isStream) {
        return json(200, {
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: "가짜 응답입니다." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      // **SSE 를 진짜와 같은 모양으로** — 스트리밍 파싱 회귀를 잡으려면 형식이 같아야 한다.
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const chunk = (delta) =>
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      chunk({ role: "assistant", content: "" });
      // reasoning_content 를 먼저 내보내야 Think(§5.3) 경로를 시험할 수 있다.
      chunk({ reasoning_content: "생각 중… " });
      for (const piece of ["가", "짜", " ", "응", "답", "입", "니", "다", "."]) chunk({ content: piece });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  json(404, { error: { message: `가짜 서버: ${url} 은 흉내 내지 않습니다`, type: "not_found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[fake-llama] 127.0.0.1:${PORT} 에서 대기 중 (v1/models · health · chat/completions)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // 안 닫히면 강제 종료 — 데몬이 응답 없이 죽지 않게.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
