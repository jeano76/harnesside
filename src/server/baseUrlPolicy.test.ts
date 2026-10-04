import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredBaseUrl, remoteBaseUrlNotice } from "./baseUrlPolicy.js";

test("원격 baseUrl 은 '지원하지 않습니다' 라고 말한다 — 조용히 무시하지 않는다", () => {
  const n = remoteBaseUrlNotice({ llama: { baseUrl: "https://api.example.com/v1" } });
  assert.match(n!, /지원하지 않습니다/);
  assert.match(remoteBaseUrlNotice({ baseUrl: "http://10.0.0.5:8080" })!, /원격/);
});

test("루프백·없음은 경고하지 않는다", () => {
  for (const u of ["http://127.0.0.1:8080", "http://localhost:8081", "http://[::1]:8080"]) assert.equal(remoteBaseUrlNotice({ baseUrl: u }), null, u);
  assert.equal(remoteBaseUrlNotice({}), null);
  assert.equal(remoteBaseUrlNotice(null), null);
});

test("읽을 수 없는 주소는 그 사실을 말한다", () => {
  assert.match(remoteBaseUrlNotice({ baseUrl: "not a url" })!, /읽을 수 없습니다/);
  assert.equal(configuredBaseUrl({ baseUrl: "  " }), null);
  assert.equal(configuredBaseUrl({ baseUrl: "http://a", llama: { baseUrl: "http://b" } }), "http://b", "llama.baseUrl 이 우선(contract 의 정규화 위치)");
});
