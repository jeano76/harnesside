import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote,
  readNotes,
  clearNotes,
  stripNotesBlock,
  annotateStaleNotes,
  parseStamp,
  formatStamp,
  STALE_MARKER,
  NOTES_HEADER,
  MAX_NOTES_CHARS,
} from "./notes.js";

test("notes append as timestamped lines, keep only the newest past the cap, and clear", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-notes-"));
  try {
    assert.equal(await readNotes(dir), "");
    await appendNote(dir, "page script is built\nwithout newlines", new Date(2026, 8, 24, 18, 5));
    assert.equal(await readNotes(dir), "- [2026-09-24 18:05] page script is built without newlines");
    for (let i = 0; i < 200; i++) await appendNote(dir, `finding ${i} ${"x".repeat(40)}`);
    const notes = await readNotes(dir);
    assert.ok(notes.length <= MAX_NOTES_CHARS);
    assert.match(notes, /finding 199/);
    assert.doesNotMatch(notes, /page script/);
    await clearNotes(dir);
    assert.equal(await readNotes(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stripNotesBlock removes an appended notes block from summary text", () => {
  assert.equal(stripNotesBlock(`summary text\n\n${NOTES_HEADER}\n- [2026-09-24 18:05] note`), "summary text");
  assert.equal(stripNotesBlock("summary only"), "summary only");
});

test("formatStamp/parseStamp round-trip, and legacy minute-only lines return null", () => {
  const stamp = formatStamp(new Date(2026, 9, 5, 7, 3));
  assert.equal(stamp, "[2026-10-05 07:03]");
  assert.equal(parseStamp(`- ${stamp} fact`)?.getTime(), new Date(2026, 9, 5, 7, 3).getTime());
  assert.equal(parseStamp("- [18:05] legacy note"), null);
  assert.equal(parseStamp("no stamp here"), null);
});

test("annotateStaleNotes flags files modified after the note, skips missing files, leaves legacy lines alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-notes-fresh-"));
  try {
    const NOTE_TIME = new Date(2026, 9, 19, 12, 0).getTime();
    const planned = `- ${formatStamp(new Date(2026, 9, 19, 12, 0))} root cause: the error points at src/loop.ts line 42`;
    const stale = `- ${formatStamp(new Date(2026, 9, 19, 12, 0))} config lives in config.yaml`;
    const legacy = "- [18:05] old note about a.txt";

    // 주입 공급자: config.yaml 은 노트 뒤에 수정됐고(stale), src/loop.ts 는 노트 전에 수정됐고(신선), a.txt 는 존재하지 않는다.
    const mtime = (p: string): Promise<number | null> => {
      if (p.endsWith("src/loop.ts")) return Promise.resolve(NOTE_TIME - 120_000);
      if (p.endsWith("config.yaml")) return Promise.resolve(NOTE_TIME + 120_000);
      return Promise.resolve(null);
    };
    const out = await annotateStaleNotes([stale, planned, legacy].join("\n"), root, { fileMtime: mtime });
    const [freshStale, freshPlanned, freshLegacy] = out.split("\n");
    assert.match(freshStale, new RegExp(`${STALE_MARKER} config\\.yaml was modified after this note`));
    assert.match(freshPlanned, /src\/loop\.ts line 42/);
    assert.doesNotMatch(freshPlanned, new RegExp(STALE_MARKER));
    assert.doesNotMatch(freshLegacy, new RegExp(STALE_MARKER));
    // 같은 줄에 같은 경로가 두 번 나와도 경고는 한 번이다.
    const dup = `- ${formatStamp(new Date(2026, 9, 19, 12, 0))} both config.yaml and config.yaml matter`;
    const dupOut = (await annotateStaleNotes(dup, root, { fileMtime: mtime })).split("\n")[0];
    assert.equal(dupOut.split(STALE_MARKER).length - 1, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("annotateStaleNotes returns empty or stamp-less input unchanged", async () => {
  assert.equal(await annotateStaleNotes("", "."), "");
  const out = await annotateStaleNotes("just a line, no stamp", ".", { fileMtime: async () => 999 });
  assert.equal(out, "just a line, no stamp");
});
