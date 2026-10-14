import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbs } from "./WorkspaceBar.js";

test("경로 막대는 루트부터 각 칸이 자기 경로를 갖는다", () => {
  assert.deepEqual(breadcrumbs("/home/u/proj"), [
    { name: "/", path: "/" },
    { name: "home", path: "/home" },
    { name: "u", path: "/home/u" },
    { name: "proj", path: "/home/u/proj" },
  ]);
  assert.deepEqual(breadcrumbs("/"), [{ name: "/", path: "/" }]);
});

test("알 수 없는 프로젝트 종류는 라벨로 보여주지 않는다", async () => {
  const { kindLabels } = await import("./WorkspaceBar.js");
  const t = (k: string) => k.replace("ws.kind.", "");
  assert.equal(kindLabels(["unknown"], t), "");
  assert.equal(kindLabels([], t), "");
  assert.equal(kindLabels(["node", "unknown"], t), "node");
  assert.equal(kindLabels(["node", "python"], t), "node/python");
});
