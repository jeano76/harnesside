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
