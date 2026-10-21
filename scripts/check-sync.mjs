/**
 * 코드와 '같이 고쳐야 하는 짝'이 어긋났는지 검사한다 (CLAUDE.md 짝 표의 기계 검사판).
 *
 *   npm run check:sync
 *
 * 짝이 어긋나도 타입 검사·테스트는 통과하고, 버전·노트는 Windows 에서 release:publish 를 돌리는
 * 순간에야 드러난다. 이것을 푸시 단계(CI)로 당긴다. 표준 node 만 쓴다(의존성 설치 전에도 돈다).
 *
 * 검사 항목
 *   1. server/src/config.ts KNOWN_ENV  ↔  README 환경변수 표 · 서버가 읽는 LISTUP_*
 *   2. 버전 — package.json 5곳 · package-lock.json · app/app.json version · android.versionCode 공식
 *   3. docs/releases/v<버전>.md 존재                  (없으면 release:publish 가 멈춘다)
 *   4. 추적 파일에 실제 tailnet 주소 · Windows 개인 경로가 없음   (이 리포는 공개다)
 *   5. (경고만) docs/ARCHITECTURE.md 구조 블록  ↔  app/src/lib · desktop/src 파일
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mismatchedVersions,
  readLockVersions,
  readVersionCode,
  readVersions,
  versionCodeOf,
} from './versions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const fails = [];
const warns = [];
let checks = 0;

function report(ok, title, detail = '') {
  checks += 1;
  console.log(`${ok ? '  ✓ ' : '  ✗ '}${title}`);
  if (ok) return;
  for (const line of detail.split('\n').filter(Boolean)) console.log(`      ${line}`);
  fails.push(title);
}

/** 실패는 아니지만 사람이 볼 것 (CI 를 막지 않는다). */
function warn(title, detail = '') {
  console.log(`  ! ${title}`);
  for (const line of detail.split('\n').filter(Boolean)) console.log(`      ${line}`);
  warns.push(title);
}

const difference = (a, b) => [...a].filter((x) => !b.has(x)).sort();

// ---------------------------------------------------------------------------
// 1. 환경변수
// ---------------------------------------------------------------------------
function checkEnv() {
  console.log('[1] server/src/config.ts KNOWN_ENV  ↔  README 환경변수 표');
  const config = read('server/src/config.ts');
  const block = config.match(/const KNOWN_ENV = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) {
    report(false, 'KNOWN_ENV 를 찾았다', '`const KNOWN_ENV = new Set([…])` 가 없다 → 이 검사를 실제 코드에 맞출 것.');
    return;
  }
  const known = new Set(block[1].match(/LISTUP_\w+/g) ?? []);
  // 표의 첫 칸만 — 본문의 $env:LISTUP_EMAIL(sync-folder 용) 같은 언급은 서버 설정이 아니다.
  const documented = new Set([...read('README.md').matchAll(/^\|\s*`(LISTUP_\w+)`\s*\|/gm)].map((m) => m[1]));
  const undocumented = difference(known, documented);
  const unknown = difference(documented, known);
  report(
    known.size > 0 && !undocumented.length && !unknown.length,
    `KNOWN_ENV ${known.size}개가 README 표와 같다`,
    (undocumented.length ? `README 표에 없음: ${undocumented.join(', ')}\n` : '') +
      (unknown.length ? `KNOWN_ENV 에 없음(서버가 "알 수 없는 환경변수" 로 경고): ${unknown.join(', ')}\n` : ''),
  );

  // 서버 코드가 쓰는 이름(process.env.X · envInt('X', …) · 주석)이 KNOWN_ENV 에 없으면, 그 변수를 쓴 사람에게
  // '무시됩니다' 경고가 뜨거나 문서가 없는 이름을 가리킨다. KNOWN_ENV 블록 자체는 빼고 센다.
  const used = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = relative === 'server/src/config.ts' ? config.replace(block[0], '') : read(relative);
        for (const m of text.matchAll(/\bLISTUP_\w+/g)) if (!used.has(m[0])) used.set(m[0], relative);
      }
    }
  };
  walk('server/src');
  const unlisted = difference(new Set(used.keys()), known);
  report(
    !unlisted.length,
    `서버 코드가 쓰는 LISTUP_* ${used.size}개가 전부 KNOWN_ENV 에 있다`,
    unlisted.map((name) => `${name}  ← ${used.get(name)}`).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 2. 버전
// ---------------------------------------------------------------------------
function checkVersions() {
  console.log('[2] 버전 — package.json · package-lock.json · app/app.json');
  const versions = readVersions(ROOT);
  const version = versions['package.json'];
  const mismatched = mismatchedVersions({ ...versions, ...readLockVersions(ROOT) }, version);
  report(
    !mismatched.length,
    `모든 곳이 ${version}`,
    `${mismatched.map(([file, v]) => `${file} = ${v}`).join('\n')}\n→ npm run version:set -- ${version}`,
  );

  let expected;
  try {
    expected = versionCodeOf(version);
  } catch (err) {
    report(false, 'android.versionCode 를 계산할 수 있다', err.message);
    return;
  }
  const code = readVersionCode(ROOT);
  report(
    code === expected,
    `app/app.json android.versionCode = ${expected}`,
    `지금 ${code}. major*10000 + minor*100 + patch 여야 한다 — 안 오르면 폰이 업데이트 설치를 거부한다.\n` +
      `→ npm run version:set -- ${version}`,
  );
  return version;
}

// ---------------------------------------------------------------------------
// 3. 릴리즈 노트
// ---------------------------------------------------------------------------
function checkReleaseNotes(version) {
  console.log('[3] docs/releases/v<버전>.md');
  const notes = `docs/releases/v${version}.md`;
  const exists = fs.existsSync(path.join(ROOT, notes));
  report(
    exists && read(notes).trim().length > 0,
    `${notes} 가 있다`,
    `${exists ? '비어 있다' : '없다'}. 릴리즈 본문으로 그대로 올라가는 파일이라 release:publish 가 여기서 멈춘다.`,
  );
}

// ---------------------------------------------------------------------------
// 4. 공개 리포에 들어가면 안 되는 것
// ---------------------------------------------------------------------------
// 노드·tailnet 이름이 박힌 주소. `<내 노드>.<tailnet>.ts.net` · `*.ts.net` 같은 일반 표기는
// '.ts.net' 바로 앞이 '>' · '*' 라 걸리지 않는다.
const TAILNET = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi;
// 드라이브:\Users\<이름> — JS 문자열 안의 겹친 역슬래시도. '<이름>' · '%USERNAME%' · '…' 은 이름 칸에 못 들어온다.
const USER_PATH = /\b[a-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)([^\\/\s"'`<>%*…|:]+)/gi;
// 사람 이름이 아닌 자리표시 · Windows 기본 폴더.
const USER_PLACEHOLDERS = new Set(['나', '이름', 'me', 'user', 'username', 'public', 'default']);

function checkPrivate() {
  console.log('[4] 추적 파일에 실제 tailnet 주소 · Windows 개인 경로 없음');
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch (err) {
    report(false, 'git ls-files 로 추적 파일을 읽었다', err.message);
    return;
  }
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue; // 지웠지만 아직 커밋하지 않은 파일
    }
    if (text.includes('\0')) continue; // 바이너리
    text.split('\n').forEach((line, i) => {
      const found = [
        ...[...line.matchAll(TAILNET)].map((m) => m[0]),
        ...[...line.matchAll(USER_PATH)].filter((m) => !USER_PLACEHOLDERS.has(m[1].toLowerCase())).map((m) => m[0]),
      ];
      if (found.length) hits.push(`${file}:${i + 1}  ${found.join(', ')}`);
    });
  }
  report(
    !hits.length,
    `추적 파일 ${files.length}개에 없음`,
    `${hits.join('\n')}\n→ \`https://<내 노드>.<tailnet>.ts.net\` · \`%USERPROFILE%\\…\` 처럼 일반 표기로 (CLAUDE.md 「주의」).\n` +
      '  이미 푸시했다면 이력에 남으므로 주소 자체를 바꿔(노드 이름 변경 등) 무효화할 것.',
  );
}

// ---------------------------------------------------------------------------
// 5. 구조 블록 (경고만)
// ---------------------------------------------------------------------------
/** ARCHITECTURE.md 에서 첫 줄이 header 인 ``` 블록. */
function codeBlock(text, header) {
  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    if (m[1].split('\n')[0].trim() === header) return m[1];
  }
  return null;
}

function checkArchitecture() {
  console.log('[5] docs/ARCHITECTURE.md 구조 블록  ↔  app/src/lib · desktop/src (경고만)');
  const doc = read('docs/ARCHITECTURE.md');
  // [폴더, 블록 첫 줄, 블록 안에서 파일을 부르는 이름, 블록이 나열한 파일 이름]
  const targets = [
    ['app/src/lib', 'app/', (f) => `lib/${f}`, /lib\/([\w.-]+\.tsx?)/g],
    ['desktop/src', 'desktop/src/', (f) => f, /[├└]─\s+([\w.-]+\.tsx?)/g],
  ];
  for (const [dir, header, nameOf, listed] of targets) {
    const block = codeBlock(doc, header);
    if (!block) {
      warn(`${dir}: 구조 블록(첫 줄 '${header}')을 찾지 못했다`, '블록 모양이 바뀌었으면 이 검사를 맞출 것.');
      continue;
    }
    const actual = fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f));
    const missing = actual.filter((f) => !block.includes(nameOf(f))).sort();
    const gone = [...new Set([...block.matchAll(listed)].map((m) => m[1]))].filter((f) => !actual.includes(f)).sort();
    if (missing.length) warn(`${dir}: 구조 블록에 없는 파일 ${missing.length}개 — ${missing.join(', ')}`);
    if (gone.length) warn(`${dir}: 구조 블록에만 있고 실제로 없는 파일 — ${gone.join(', ')}`);
    if (!missing.length && !gone.length) console.log(`  ✓ ${dir}: 파일 ${actual.length}개가 구조 블록과 같다`);
  }
}

// ---------------------------------------------------------------------------
checkEnv();
const version = checkVersions();
if (version) checkReleaseNotes(version);
checkPrivate();
checkArchitecture();

console.log('');
if (warns.length) {
  console.log(`경고 ${warns.length}건 (실패 아님):`);
  for (const w of warns) console.log(`  - ${w}`);
}
if (fails.length) {
  console.log(`실패 ${fails.length}/${checks}:`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`모두 통과 (${checks}개 검사)`);
}
