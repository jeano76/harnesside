import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli.js";

test("parseArgs: setup이 독립 명령이다", () => {
  const p = parseArgs(["setup"]);
  assert.equal(p.command, "setup");
  assert.deepEqual(p.rest, []);
});

test("parseArgs: setup 인자가 rest에 남는다", () => {
  const p = parseArgs(["setup", "--no-shortcut", "--models-dir=/tmp/m"]);
  assert.equal(p.command, "setup");
  assert.ok(p.rest.includes("--no-shortcut"));
  assert.ok(p.flags.has("--no-shortcut"));
});
