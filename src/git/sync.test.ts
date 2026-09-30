/**
 * GitHub 연동 테스트 (§9.3 · P14 · §10.2 `git/*` 행).
 *
 * 이 모듈에서 가장 중요한 것은 **pull 이 충돌에서 멈춘다** 는 것이다.
 * 자동 병합은 사용자가 쓰지 않은 코드를 사용자의 파일에 섞고, 그 사실을 아무도
 * 모른다. 그래서 그 경로를 **직접 재현**해 확인한다.
 *
 * 실제로 임시 저장소를 **세 개** 만들어 clone → 수정 → pull 을 시나리오별로 돌린다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { planClone, cloneArgs, planCommit, pull, push, summarize, summaryLabel, redactUrl, authOf, rejectForce, needsFileScheme, commit } from "./sync.js";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};
// `pull()` 은 **자식 프로세스** 에서 git 을 돌리고 그쪽의 `process.env` 를 상속한다.
// 여기서 설정한 git 정체성(GIT_AUTHOR_*) 이 없으면 병합 커밋을 쓸 때
// "Author identity unknown" 으로 실패하고, 그 실패는 **충돌이 아니라 일반 오류** 로
// 분류된다 — 그래서 CI 러너(git 전역 설정 없음)에서만 "충돌" assertion 이 깨졌다.
// 테스트가 쓰는 git 과 코드가 쓰는 git 이 **같은 환경** 을 보도록 맞춘다.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
});

const g = (cwd: string, ...a: string[]) => run("git", ["-C", cwd, ...a], { env: GIT_ENV });

async function tmp() {
  return mkdtemp(join(tmpdir(), "harnesside-git2-"));
}

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await g(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "one\n");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-q", "-m", "init");
  return dir;
}

// ---------------------------------------------------------------- 계획 (순수)

// eslint-disable-next-line no-control-regex
test("clone 인자는 **배열** — 쉼/공백/따옴표가 있어도 그대로 전달된다", () => {
  const p = planClone({ url: "https://github.com/me/repo.git", dir: "my dir,with,commas" });
  const args = cloneArgs(p);
  assert.deepEqual(args, ["clone", "--depth", "1", "--", "https://github.com/me/repo.git", "my dir,with,commas"]);
  // 문자열로 이어붙였다면 깨진다 — 배열이 유일하게 안전한 전달 방식이다
  assert.equal(args.includes(","), false, "쉼이 하나의 인자로 남았다");
});

test("clone 은 **얕게** — 20 GB 저장소를 통째로 받지 않는다", () => {
  assert.equal(planClone({ url: "u", dir: "d" }).depth, 1);
  assert.equal(cloneArgs(planClone({ url: "u", dir: "d" })).includes("--depth"), true);
  // branch 지정하면 그대로 들어간다
  assert.ok(cloneArgs(planClone({ url: "u", dir: "d", branch: "dev" })).includes("dev"));
});

test("clone 경로가 `-` 로 시작해도 **옵션으로 안 읽힌다** (`--` 구분자)", () => {
  const args = cloneArgs(planClone({ url: "https://x/y.git", dir: "--upload-pack=evil" }));
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "`--` 가 없다 — 경로가 옵션으로 해석된다");
  assert.deepEqual(args.slice(sep + 1), ["https://x/y.git", "--upload-pack=evil"]);
});

test("커밋 메시지가 **비면 거부** — 빈 커밋이 히스토리를 오염시킨다", () => {
  for (const m of ["", "   ", "\n\t "]) {
    const r = planCommit({ message: m, paths: ["a.txt"], all: false, allowEmpty: false });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "empty-message");
  }
});

test("경로가 없으면 거부 — `commit -a` 로 **전부** 커밋되면 안 된다", () => {
  const r = planCommit({ message: "m", paths: [], all: false, allowEmpty: false });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "no-paths");
  // 명시적으로 전부 커밋하라고 한 경우만 -a
  const all = planCommit({ message: "m", paths: [], all: true, allowEmpty: false });
  assert.equal(all.ok, true);
  assert.ok(all.ok && all.args.includes("-a"));
});

test("커밋 경로 뒤에도 `--` — 파일명이 옵션처럼 보이면 안 된다", () => {
  const r = planCommit({ message: "m", paths: ["-x", "--force"], all: false, allowEmpty: false });
  assert.ok(r.ok);
  if (!r.ok) return;
  const sep = r.args.indexOf("--");
  assert.ok(sep > 0);
  assert.deepEqual(r.args.slice(sep + 1), ["-x", "--force"]);
});

test("메시지가 500자 넘으면 거부 — 제목만 남고 잘리는 걸 사용자는 모른다", () => {
  const r = planCommit({ message: "x".repeat(600), paths: ["a"], all: false, allowEmpty: false });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "too-long");
});

test("커밋 제목은 **첫 줄** — 미리보기가 실제 제목과 같아야 한다", () => {
  const r = planCommit({ message: "feat: 무언가\n\n긴 본문", paths: ["a"], all: false, allowEmpty: false });
  assert.equal(r.ok && r.message, "feat: 무언가");
});

test("force push 는 **거부** — 실수로 원격 이력을 지우는 경로를 만들지 않는다", () => {
  assert.equal(rejectForce(["push", "--force"]).ok, false);
  assert.equal(rejectForce(["push", "-f"]).ok, false);
  assert.equal(rejectForce(["push", "--force-with-lease"]).ok, false);
  assert.equal(rejectForce(["push", "origin", "main"]).ok, true);
});

test("URL 의 자격증명을 **가린다** — 로그에 남으면 안 된다", () => {
  const s = redactUrl("https://user:hunter2@github.com/me/repo.git");
  assert.equal(s.includes("hunter2"), false, `비밀번호가 노출됐다: ${s}`);
  assert.match(s, /\*\*\*/);
  // SSH 는 자격증명이 URL 에 없어도 키 경로는 마스킹
  assert.equal(redactUrl("git@github.com:me/repo.git"), "git@github.com:me/repo.git");
});

test("인증 방식 판별", () => {
  assert.equal(authOf("git@github.com:me/repo.git"), "ssh");
  assert.equal(authOf("https://github.com/me/repo.git"), "https");
  assert.equal(authOf("github.com/me/repo"), "none");
});

test("요약 라벨이 **ahead/behind 숫자** 를 말한다", () => {
  const l = summaryLabel({ branch: "main", ahead: 2, behind: 1, shallow: false, files: [{ path: "a", code: " M", staged: false, status: "modified" }], clean: false });
  assert.match(l, /로컬에 2커밋/);
  assert.match(l, /원격에 1커밋/);
  assert.match(l, /변경 1개/);
  assert.match(summaryLabel({ branch: "main", ahead: 0, behind: 0, shallow: false, files: [], clean: true }), /깨끗하고 동기화됨/);
  // 얕은 복사에서 "깨끗하고 동기화됨" 은 **거짓말** 이다
  const shallow = summaryLabel({ branch: "main", ahead: 0, behind: 0, shallow: true, files: [], clean: true });
  assert.equal(/깨끗하고 동기화됨/.test(shallow), false, "얕은 복사를 동기화됨이라 했다");
  assert.match(shallow, /계산할 수 없/);
});

// ---------------------------------------------------------------- 실측

test("clone → 수정 → 커밋 → pull 이 실제로 동작한다 (로컬 파일 URL)", async () => {
  const root = await tmp();
  try {
    const origin = await initRepo(join(root, "origin.git"));
    const a = join(root, "a");
    const b = join(root, "b");

    // **로컬 경로로 복제한다** (git 2.53.0 실측). `--depth` 를 경로 clone 에 주면
    // git 이 **무시하고 경고**한다("--depth 옵션은 로컬 복제에서 무시됩니다").
    // 완전 복사가 되어야 **병합(충돌)** 을 시험할 수 있다 — 얕은 복사에는 공통 조상이
    // 없어 병합이 아예 성립하지 않는다. 얕은 쪽은 별도 테스트가 다룬다.
    await run("git", ["clone", "--", origin, a], { env: GIT_ENV });
    await run("git", ["clone", "--", origin, b], { env: GIT_ENV });
    assert.equal((await readFile(join(a, "a.txt"), "utf8")).trim(), "one", "clone 내용");

    // origin 에 새 커밋
    await writeFile(join(origin, "a.txt"), "two\n");
    await g(origin, "add", "-A");
    await g(origin, "commit", "-q", "-m", "second");

    // **fetch 전의 behind=0 은 "동기화됨" 이 아니라 "모름" 이다.** 그래서 라벨이
    // 기준을 밝힌다. fetch 해야 behind 가 계산된다.
    const beforeFetch = await summarize(a);
    assert.equal(beforeFetch.ok, true);
    if (beforeFetch.ok) {
      assert.equal(beforeFetch.value.shallow, false, "로컬 경로 클론인데 얕다고 판정했다");
      assert.match(summaryLabel(beforeFetch.value), /마지막 fetch 기준/);
    }
    await g(a, "fetch", "origin");
    const before = await summarize(a);
    assert.equal(before.ok, true);
    if (before.ok) assert.equal(before.value.behind >= 1, true, `behind=${before.value.behind}`);

    // pull → fast-forward
    const p1 = await pull(a, "main");
    assert.equal(p1.ok, true, `pull 실패: ${p1.detail}`);
    assert.equal(p1.needsUser, false);
    assert.equal((await readFile(join(a, "a.txt"), "utf8")).trim(), "two", "pull 후 내용");

    // b 는 같은 내용을 로컬에서 바꾸고 커밋
    await writeFile(join(b, "a.txt"), "three\n");
    await g(b, "add", "-A");
    await g(b, "commit", "-q", "-m", "local");
    // origin 도 바꿔서 **충돌**을 만든다
    await writeFile(join(origin, "a.txt"), "origin-change\n");
    await g(origin, "add", "-A");
    await g(origin, "commit", "-q", "-m", "remote change");

    // b 의 pull → **충돌에서 멈춘다**
    const p2 = await pull(b, "main");
    assert.equal(p2.ok, false, "충돌인데 성공으로 보고됐다");
    assert.equal(p2.outcome, "conflict");
    assert.equal(p2.needsUser, true, "충돌인데 사용자 개입을 요구하지 않는다");
    assert.ok(p2.filesChanged.length > 0, "충돌 파일을 알려주지 않는다");
    assert.match(p2.detail, /자동 병합하지 않았습니다/);

    // **자동 병합이 일어나지 않았어야** 한다 — 충돌 표식이 남는다
    const status = await g(b, "status", "--porcelain");
    assert.match(status.stdout, /^UU|^AA|^DU|^UD/m, `충돌 표식이 없다: ${status.stdout}`);
    // 두 쪽 내용이 **모두** 파일에 남아 있어야 한다(한 쪽으로 덮이지 않음)
    const body = await readFile(join(b, "a.txt"), "utf8");
    assert.match(body, /three/, "로컬 변경이 사라졌다 — 자동 해결됐다");
    assert.match(body, /origin-change/, "원격 변경이 사라졌다 — 자동 해결됐다");
    assert.match(body, /^<{7}|^={7}|^>{7}/m, "충돌 마커가 없다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("파일이 `--evil` 처럼 보여도 pull 이 **깨지지 않는다**", async () => {
  const root = await tmp();
  try {
    const origin = await initRepo(join(root, "origin.git"));
    const repo = join(root, "r");
    // **clone 으로** 만든다. `init` + 별도 커밋은 origin 과 **무관한 이력**이라
    // pull 이 "refusing to merge unrelated histories" 로 막힌다(한 번 실제로 혼동했다).
    // 그건 "--evil" 때문이 아니었다.
    await run("git", ["clone", "--", origin, repo], { env: GIT_ENV });
    await writeFile(join(repo, "--evil"), "x\n");
    await g(repo, "add", "-A");
    await g(repo, "commit", "-q", "-m", "odd file");
    const r = await pull(repo, "main");
    assert.equal(r.ok, true, `pull 실패: ${r.detail}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("저장소가 아니면 **구체적으로** 말한다 — '변경 없음' 과 구분된다", async () => {
  const dir = await tmp();
  try {
    const s = await summarize(dir);
    assert.equal(s.ok, false);
    if (!s.ok) assert.equal(s.reason, "not-a-repo");
    const p = await pull(dir, "main");
    assert.equal(p.ok, false);
    assert.equal(p.outcome, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("원격이 없으면 push 는 **무엇을 할지** 말해준다", async () => {
  const dir = await initRepo(await tmp());
  try {
    const r = await push(dir, "main", true);
    assert.equal(r.ok, false);
    assert.ok(r.detail.length > 0, "실패 이유가 없다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("얕은 복사를 **알아본다** — 모름을 0 이나 동기화됨 으로 말하지 않는다", async () => {
  const root = await tmp();
  try {
    const origin = await initRepo(join(root, "origin.git"));
    const a = join(root, "a");
    // `file://` 와 `--depth` 가 **둘 다** 있어야 얕은 복사가 된다
    // (로컬 경로 clone 은 git 이 --depth 를 무시하고 경고한다 — git 2.53.0 실측).
    await run("git", ["clone", "--depth", "1", "--", `file://${origin}`, a], { env: GIT_ENV });

    const st = await summarize(a);
    assert.equal(st.ok, true);
    if (!st.ok) return;
    assert.equal(st.value.shallow, true, "얕은 클론인데 shallow=false 로 보고했다");
    // "깨끗하고 동기화됨" 은 얕은 클론에서 **거짓말** 이다 — 계산하지 못한 것이다.
    assert.equal(/깨끗하고 동기화됨/.test(summaryLabel(st.value)), false);
    assert.match(summaryLabel(st.value), /계산할 수 없/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("얕은 복사의 **fast-forward pull 은 정상 동작** 한다 — 막으면 안 된다", async () => {
  // "얕으면 병합이 안 된다" 는 **거짓** 이었다(git 2.53.0 실측). 얕은 복사가 FF 를
  // 막으면 사용자는 얕게 받은 이득은 그대로 두고 불이익만 본다. 실제로 통과시킨다.
  const root = await tmp();
  try {
    const origin = await initRepo(join(root, "origin.git"));
    const a = join(root, "a");
    await run("git", ["clone", "--depth", "1", "--", `file://${origin}`, a], { env: GIT_ENV });

    await writeFile(join(origin, "a.txt"), "two\n");
    await g(origin, "add", "-A");
    await g(origin, "commit", "-q", "-m", "second");

    const r = await pull(a, "main");
    assert.equal(r.ok, true, `얕은 복사의 FF 를 막았다: ${r.detail}`);
    assert.equal(r.outcome, "merged");
    assert.equal((await readFile(join(a, "a.txt"), "utf8")).trim(), "two");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("얕은 복사에서 **갈라진 병합** 이 실패하면 충돌로 오인하지 않는다", async () => {
  const root = await tmp();
  try {
    const origin = await initRepo(join(root, "origin.git"));
    const a = join(root, "a");
    await run("git", ["clone", "--depth", "1", "--", `file://${origin}`, a], { env: GIT_ENV });

    // 로컬과 원격을 **갈라지게** 만든다 → 공통 조상이 필요하다
    await writeFile(join(a, "b.txt"), "local\n");
    await g(a, "add", "-A");
    await g(a, "commit", "-q", "-m", "local only");
    await writeFile(join(origin, "a.txt"), "two\n");
    await g(origin, "add", "-A");
    await g(origin, "commit", "-q", "-m", "second");

    const r = await pull(a, "main");
    if (r.ok) {
      // git 이 병합에 성공했다면 그것이 정답 — 막지 않는다(버전마다 다르다).
      return;
    }
    // 실패했다면 충돌(사용자가 해결)과 설정 문제(사용자가 복구)를 구분해야 한다.
    // 얕은 복사를 충돌로 말하면 존재하지 않는 해결 작업을 시킨다.
    assert.equal(r.outcome === "conflict", false, "얕은 복사를 충돌로 보고했다 — 사용자가 해결할 문제가 아니다");
    assert.ok(r.detail.length > 0, "실패 이유가 없다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("**로컬 경로** clone 은 --depth 를 무시한다 — 얕게 받을 줄 알면 20 GB 를 받는다", () => {
  // git 2.53.0 실측: 경로 clone 에 --depth 를 주면 "무시됩니다" 경고 + 완전 복사.
  assert.equal(needsFileScheme("/home/u/repo.git"), true, "절대 경로는 로컬 경로다");
  assert.equal(needsFileScheme("./repo"), true);
  assert.equal(needsFileScheme("../repo"), true);
  // **scp 형태는 로컬 경로가 아니다** — `://` 가 없어도 원격이다. 이걸 로컬로
  // 오인하면 실제 원격 저장소 앞에 file:// 이 붙고 아무 일도 안 일어난다.
  assert.equal(needsFileScheme("git@github.com:me/repo.git"), false, "scp 형태 SSH 를 로컬로 봤다");
  assert.equal(needsFileScheme("ssh://git@github.com/me/repo.git"), false);
  assert.equal(needsFileScheme("https://github.com/me/repo.git"), false);
  // 스킴도 경로도 아니면 애매 — 로컬로 보아 경고하는 편이 안전하다
  assert.equal(needsFileScheme("github.com/me/repo.git"), true);
});

// ---------------------------------------------------------------- 커밋 실행

test("커밋이 **실제로 쌓인다** — 해시와 커밋한 파일을 돌려준다", async () => {
  const dir = await initRepo(await tmp());
  try {
    await writeFile(join(dir, "b.txt"), "둘째\n");
    const r = await commit(dir, { message: "b 추가", paths: ["b.txt"], all: false, allowEmpty: false });
    assert.equal(r.ok, true, !r.ok ? r.detail : "");
    if (!r.ok) return;
    // **해시는 커밋 뒤의 HEAD** 다. 미리 읽으면 직전 커밋의 해시를 말한다(옛 사실).
    assert.equal(r.value.hash.length, 40, `해시가 아니다: ${r.value.hash}`);
    const show = await g(dir, "show", "--name-only", "--format=%s", "-1");
    assert.match(show.stdout, /b\.txt/);
    assert.match(show.stdout, /b 추가/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("저장소 **밖 경로** 는 거부한다 — 고른 파일만 커밋돼야 한다", async () => {
  const dir = await initRepo(await tmp());
  try {
    await writeFile(join(dir, "c.txt"), "셋째\n");
    const r = await commit(dir, { message: "밖 경로", paths: ["/etc/passwd"], all: false, allowEmpty: false });
    assert.equal(r.ok, false, "저장소 밖 경로를 그대로 커밋했다");
    // **어떤 경로였는지** 를 말해야 사용자가 고칠 수 있다.
    assert.match(r.detail, /etc\/passwd/, `거부 사유에 경로가 없다: ${r.detail}`);
    // 파일은 그대로 남아 있어야 한다 — 거부되었으니 커밋도 없다.
    const log = await g(dir, "log", "--format=%s");
    assert.doesNotMatch(log.stdout, /밖 경로/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**빈 메시지** 는 커밋하지 않는다 — 아무것도 안 한 커밋은 이력의 노이즈다", async () => {
  const dir = await initRepo(await tmp());
  try {
    await writeFile(join(dir, "d.txt"), "넷째\n");
    const r = await commit(dir, { message: "   ", paths: ["d.txt"], all: false, allowEmpty: true });
    assert.equal(r.ok, false, "빈 메시지로 커밋했다");
    const log = await g(dir, "log", "--format=%s");
    assert.match(log.stdout, /^init$/m, "커밋이 추가되었다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`all` 은 **추적 중인 변경만** — 새 파일은 조용히 빠진다", async () => {
  const dir = await initRepo(await tmp());
  try {
    await writeFile(join(dir, "a.txt"), "고침\n");
    await writeFile(join(dir, "untracked.txt"), "추적 안 됨\n");
    const r = await commit(dir, { message: "수정만", paths: [], all: true, allowEmpty: false });
    assert.equal(r.ok, true, !r.ok ? r.detail : "");
    const names = await g(dir, "show", "--name-only", "--format=", "-1");
    assert.match(names.stdout, /a\.txt/);
    // **빠졌다는 사실을 숨기지 않는다.** all 은 "모두" 라는 이름과 달리
    // 미추적 파일을 넣지 않는다 — 사용자가 알아야 한다.
    assert.doesNotMatch(names.stdout, /untracked\.txt/);
    const st = await g(dir, "status", "--porcelain");
    assert.match(st.stdout, /\?\? untracked\.txt/, "미추적 파일이 커밋되어 사라졌다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
