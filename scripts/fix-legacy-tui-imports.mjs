/** P0-3 보조: src/legacy-tui/ 안의 import 경로를 새 깊이에 맞춰 고친다 (idempotent). */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = join(ROOT, 'src/legacy-tui');

/** 이식 모듈(legacy-tui 밖) 경로 목록 — "../x.js" 로 바꿔야 한다. */
const OUTSIDE = [
  'config', 'crashHandler', 'instanceGuard', 'selfUpdate',
  'agent/loop', 'agent/harness', 'agent/textSanitize', 'agent/toolCallSalvage', 'agent/gitCheckpoint',
  'backend/llamaServer', 'backend/openaiClient', 'backend/detect', 'backend/types',
  'compaction/checkpoint', 'compaction/compactor', 'compaction/notes',
  'hermes/selfHeal', 'hermes/selfImprove',
  'setup/bootstrap', 'setup/hardware', 'setup/tuning', 'setup/ports', 'setup/llamaCpp',
  'skills/loader',
  'tools/index', 'tools/browser', 'tools/diff',
];

let touched = 0;
for (const name of readdirSync(DIR)) {
  const p = join(DIR, name);
  if (!statSync(p).isFile() || !/\.(ts|tsx)$/.test(name)) continue;
  const before = readFileSync(p, 'utf8');
  let after = before;
  for (const mod of OUTSIDE) {
    // "./config.js" → "../config.js"  (이미 "../"면 건드리지 않음)
    after = after.split(`"./${mod}.js"`).join(`"../${mod}.js"`);
  }
  // 같은 디렉터리 동료는 "./App.js" 그대로 둔다
  after = after.split('"../legacy-tui/').join('"./');
  if (after !== before) {
    writeFileSync(p, after);
    touched++;
    console.log('  fixed', relative(ROOT, p));
  }
}
console.log(`\n변경 파일 ${touched}`);
