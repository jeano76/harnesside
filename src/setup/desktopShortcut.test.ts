import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  windowsShortcutScript,
  linuxDesktopFile,
  shortcutFileName,
  desktopDir,
  defaultShortcutSpec,
  createDesktopShortcut,
  type ShortcutSpec,
} from "./desktopShortcut.js";

const spec: ShortcutSpec = {
  name: "HarnessIDE",
  target: "C:\\Program Files\\nodejs\\node.exe",
  args: '"C:\\harnesside\\dist\\server\\index.js"',
  workDir: "C:\\harnesside",
  description: "test",
};

describe("desktopShortcut", () => {
  test("lnk 이름은 win32에서 .lnk", () => {
    assert.equal(shortcutFileName(spec, "win32"), "HarnessIDE.lnk");
  });

  test("lnk 이름은 linux에서 .desktop", () => {
    assert.equal(shortcutFileName(spec, "linux"), "HarnessIDE.desktop");
  });

  test("powershell 스크립트가 WScript.Shell로 저장한다", () => {
    const s = windowsShortcutScript(spec, "C:\\Users\\u\\Desktop\\HarnessIDE.lnk");
    assert.match(s, /WScript\.Shell/);
    assert.match(s, /CreateShortcut/);
    assert.match(s, /Save\(\)/);
    assert.match(s, /node\.exe/);
  });

  test("아이콘이 없으면 대상 자체 아이콘을 쓴다 (없는 경로를 가리키지 않음)", () => {
    const s = windowsShortcutScript(spec, "C:\\x\\HarnessIDE.lnk");
    assert.match(s, /IconLocation/);
    assert.match(s, /node\.exe,0/);
  });

  test("지정한 아이콘이 있으면 그것을 쓴다", () => {
    const s = windowsShortcutScript({ ...spec, iconPath: "C:\\x\\icon.ico" }, "C:\\x\\HarnessIDE.lnk");
    assert.match(s, /icon\.ico/);
  });

  test(".desktop 본문이 Exec·Terminal을 갖는다", () => {
    const body = linuxDesktopFile(spec);
    assert.match(body, /^\[Desktop Entry\]/m);
    assert.match(body, /^Exec=/m);
    assert.match(body, /^Terminal=true$/m);
  });

  test("진입점이 없으면 스펙이 null (없는 것을 가리키지 않음)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-noentry-"));
    assert.equal(await defaultShortcutSpec(dir), null);
  });

  test("진입점이 있으면 스펙이 node를 가리킨다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-entry-"));
    mkdirSync(join(dir, "dist", "server"), { recursive: true });
    writeFileSync(join(dir, "dist", "server", "index.js"), "x");
    const s = await defaultShortcutSpec(dir, { nodeExe: process.execPath });
    assert.ok(s);
    assert.equal(s!.target, process.execPath);
    assert.match(s!.args, /index\.js/);
  });

  test("진입점 없이 createDesktopShortcut은 실패한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-noshort-"));
    const r = await createDesktopShortcut(dir, { platform: "linux", home: dir });
    assert.equal(r.ok, false);
  });

  test("linux에서 .desktop이 생긴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-short-"));
    mkdirSync(join(dir, "dist", "server"), { recursive: true });
    writeFileSync(join(dir, "dist", "server", "index.js"), "x");
    const r = await createDesktopShortcut(dir, { platform: "linux", home: dir, nodeExe: process.execPath });
    assert.equal(r.ok, true);
    assert.match(r.path!, /\.desktop$/);
  });

  test("win32에서 powershell 실패는 실패로 말한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-shortwin-"));
    mkdirSync(join(dir, "dist", "server"), { recursive: true });
    writeFileSync(join(dir, "dist", "server", "index.js"), "x");
    const r = await createDesktopShortcut(dir, {
      platform: "win32",
      home: dir,
      nodeExe: process.execPath,
      run: async () => { throw new Error("powershell 없음"); },
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /powershell/i);
  });

  test("desktopDir은 홈 아래 Desktop", () => {
    assert.equal(desktopDir("/home/u", "linux"), "/home/u/Desktop");
    assert.ok(desktopDir("C:\\Users\\u", "win32").endsWith("Desktop"));
  });
});
