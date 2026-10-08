/** Line-based diff for showing file changes in the TUI (PROMPT.md §6:
 *  changes should be visible to the user, not just summarized in text). */

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

interface DiffOp {
  type: "add" | "del" | "ctx";
  line: string;
}

/** Edit-distance cap for Myers. The trace it keeps for backtracking is
 *  ~D² ints, so D=2000 is ~16MB worst case. Past it the changed middle is
 *  shown as one replaced block — still correct, just not minimal. */
const MAX_EDIT_DISTANCE = 2000;

/** Line diff (P2-1). Was an O(n·m) LCS table that skipped any file past
 *  4M cells (2,000×2,000 lines) — a 20k-line file got no diff at all, and
 *  a 1,999-line file allocated a 4M-entry table for a one-line edit.
 *  Now: strip the common prefix/suffix (an agent edit usually touches a
 *  few lines, so this alone usually leaves a tiny middle), then Myers
 *  O((n+m)·D) on what's left. */
export function lineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  let pre = 0;
  const maxPre = Math.min(oldLines.length, newLines.length);
  while (pre < maxPre && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  const maxSuf = maxPre - pre;
  while (suf < maxSuf && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;

  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);
  const middle = myers(a, b, MAX_EDIT_DISTANCE) ?? [
    ...a.map((line): DiffOp => ({ type: "del", line })),
    ...b.map((line): DiffOp => ({ type: "add", line })),
  ];
  return [
    ...oldLines.slice(0, pre).map((line): DiffOp => ({ type: "ctx", line })),
    ...middle,
    ...oldLines.slice(oldLines.length - suf).map((line): DiffOp => ({ type: "ctx", line })),
  ];
}

/** Myers' greedy O((n+m)·D) shortest edit script. Returns null when the
 *  edit distance exceeds maxD. Deletions are preferred over insertions on
 *  ties, so a changed line reads "- old" then "+ new". */
function myers(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: "add", line }));
  if (m === 0) return a.map((line) => ({ type: "del", line }));

  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  // trace[d] = furthest x per diagonal k ∈ [-d, d] after round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], D: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "ctx", line: a[--x] });
      y--;
    }
    if (down) ops.push({ type: "add", line: b[--y] });
    else ops.push({ type: "del", line: a[--x] });
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "ctx", line: a[--x] });
    y--;
  }
  return ops.reverse();
}

/**
 * Renders a colored, context-trimmed diff as an ANSI string ready to print
 * directly to the terminal. Returns "" when there's no change.
 */
export function formatDiff(path: string, oldText: string, newText: string, contextLines = 3): string {
  if (oldText === newText) return "";
  const ops = lineDiff(oldText.split("\n"), newText.split("\n"));

  const show = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type !== "ctx") {
      for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k++) {
        show[k] = true;
      }
    }
  });

  const lines: string[] = [`${ANSI.bold}--- ${path}${ANSI.reset}`];
  let prevShown = false;
  ops.forEach((op, idx) => {
    if (!show[idx]) {
      if (prevShown) lines.push(`${ANSI.gray}  ⋮${ANSI.reset}`);
      prevShown = false;
      return;
    }
    prevShown = true;
    if (op.type === "add") lines.push(`${ANSI.green}+ ${op.line}${ANSI.reset}`);
    else if (op.type === "del") lines.push(`${ANSI.red}- ${op.line}${ANSI.reset}`);
    else lines.push(`${ANSI.gray}  ${op.line}${ANSI.reset}`);
  });
  return lines.join("\n");
}
