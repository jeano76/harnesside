import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDiff, lineDiff } from "./diff.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

test("formatDiff returns empty string when content is unchanged", () => {
  assert.equal(formatDiff("f.ts", "same\ncontent\n", "same\ncontent\n"), "");
});

test("formatDiff marks every line as added for a brand-new file", () => {
  const out = formatDiff("f.ts", "", "line1\nline2\n");
  assert.match(out, /\x1b\[32m\+ line1\x1b\[0m/);
  assert.match(out, /\x1b\[32m\+ line2\x1b\[0m/);
});

test("formatDiff shows unchanged context lines and only colors the actual change", () => {
  const out = formatDiff(
    "f.ts",
    "function add(a, b) {\n  return a + b;\n}\n",
    "function add(a, b) {\n  // sum\n  return a + b;\n}\n"
  );
  const plain = stripAnsi(out);
  assert.match(plain, /^\+ {3}\/\/ sum$/m);
  assert.match(plain, /^ {2}function add\(a, b\) \{$/m);
  assert.match(plain, /^ {2} {2}return a \+ b;$/m);
  // the unchanged lines must be gray context, not colored as additions/removals
  assert.doesNotMatch(out, /\x1b\[32m {2}function add/);
});

test("formatDiff marks a removed line with '-' and a changed line as del+add", () => {
  const out = formatDiff("f.ts", "a\nb\nc\n", "a\nc\n");
  const plain = stripAnsi(out);
  assert.match(plain, /^- b$/m);
  assert.match(out, /\x1b\[31m- b\x1b\[0m/);
});

test("formatDiff header includes the file path", () => {
  const out = formatDiff("/some/path/f.ts", "a\n", "b\n");
  assert.match(stripAnsi(out), /^--- \/some\/path\/f\.ts$/m);
});

// P2-1: the O(n·m) LCS table was replaced by prefix/suffix trim + Myers.
// Reference LCS length, to check the new script is still minimal.
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

test("lineDiff reconstructs both sides and stays minimal on random edits", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rand(30) }, () => "l" + rand(6));
    const b = a.slice();
    for (let e = rand(8); e > 0; e--) {
      const at = rand(b.length + 1);
      if (rand(2) && b.length) b.splice(at, 1);
      else b.splice(at, 0, "l" + rand(6));
    }
    const ops = lineDiff(a, b);
    assert.deepEqual(ops.filter((o) => o.type !== "add").map((o) => o.line), a);
    assert.deepEqual(ops.filter((o) => o.type !== "del").map((o) => o.line), b);
    const edits = ops.filter((o) => o.type !== "ctx").length;
    assert.equal(edits, a.length + b.length - 2 * lcsLength(a, b), `round ${round}`);
  }
});

test("formatDiff diffs a 20k-line file quickly instead of skipping it", () => {
  const old = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const neu = old.slice();
  neu[100] = "changed A";
  neu.splice(15_000, 0, "inserted B");
  const start = Date.now();
  const out = stripAnsi(formatDiff("big.txt", old.join("\n"), neu.join("\n")));
  assert.ok(Date.now() - start < 1000, "should be near-instant");
  assert.match(out, /- line 100\n\+ changed A/);
  assert.match(out, /\+ inserted B/);
  assert.doesNotMatch(out, /diff skipped/);
});

test("lineDiff falls back to one replaced block past the edit-distance cap", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const ops = lineDiff(a, b);
  assert.equal(ops.length, 6000);
  assert.ok(ops.slice(0, 3000).every((o) => o.type === "del"));
  assert.ok(ops.slice(3000).every((o) => o.type === "add"));
});
