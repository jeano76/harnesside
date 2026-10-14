import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDir, ensureArchiveWritable, messagesToEntries, newArchivePath, pruneArchive, writeArchive, MAX_ARCHIVE_FILES } from "./archive.js";
import type { ChatMessage } from "../backend/types.js";

async function tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-archive-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the archive keeps full message text, tool calls and ids in a grep-able plain file", () =>
  tmp(async (dir) => {
    const messages: ChatMessage[] = [
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "FULL-OUTPUT " + "x".repeat(5000) },
    ];
    const path = newArchivePath(dir, "compaction");
    assert.ok(path.startsWith(archiveDir(dir)));
    assert.equal(await writeArchive(dir, path, messagesToEntries(messages)), true);
    const text = await readFile(path, "utf8");
    assert.match(text, /=== entry m0 \| user ===\nfix the login bug/);
    assert.ok(text.includes('read_file({"path":"a.ts"})'), "tool call arguments are kept");
    assert.ok(text.includes("tool c1"), "tool result is labeled with its call id");
    assert.ok(text.includes("x".repeat(5000)), "nothing is truncated");
  }));

test("writing fails softly: an unwritable location returns false instead of throwing", () =>
  tmp(async (dir) => {
    await writeFile(join(dir, ".harnesside"), "a file where a directory is needed");
    assert.equal(await ensureArchiveWritable(dir), false);
    assert.equal(await writeArchive(dir, newArchivePath(dir, "masked"), [{ id: "a", label: "x", text: "y" }]), false);
    assert.equal(await writeArchive(dir, join(dir, "unused.txt"), []), false, "nothing to write");
  }));

test("old archive files are pruned beyond the limit, newest kept", () =>
  tmp(async (dir) => {
    const d = archiveDir(dir);
    await mkdir(d, { recursive: true });
    for (let i = 0; i < MAX_ARCHIVE_FILES + 5; i++) await writeFile(join(d, `2026-10-14T00-00-${String(i).padStart(2, "0")}-000-masked.txt`), "x");
    await pruneArchive(dir);
    const left = (await readdir(d)).sort();
    assert.equal(left.length, MAX_ARCHIVE_FILES);
    assert.ok(left[0].includes("-05-"), "the 5 oldest were removed");
  }));

test("two archive paths requested in the same millisecond never collide", () => {
  const now = new Date("2026-10-14T00:00:00.000Z");
  const paths = new Set(Array.from({ length: 50 }, () => newArchivePath("/p", "compaction", now)));
  assert.equal(paths.size, 50);
});
