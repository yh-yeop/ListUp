/**
 * GitHub 릴리즈를 올린다 — 서버 묶음, 안드로이드 APK, PC 설치 파일을 함께.
 *
 *   npm run release:publish
 *   npm run release:publish -- --skip-ci   CI 결과 확인만 건너뛴다(로컬 검사는 그대로 돈다)
 *
 * 설치형 클라이언트는 GitHub 의 최신 릴리즈를 보고 업데이트를 제안하므로(app/src/lib/updates.ts),
 * 릴리즈는 이 명령으로만 올려 태그·버전·파일이 어긋나지 않게 한다.
 *
 * 하는 일
 *   1. 확인 — gh 로그인, 작업 트리 깨끗함, main 이 원격과 같음(푸시됨), 태그 v<버전> 이 아직 없음,
 *      릴리즈 노트 docs/releases/v<버전>.md 가 있음, 버전이 모든 곳에서 같음, 서명 키가 있음,
 *      이 커밋의 GitHub CI 가 모두 끝나 성공함, 로컬 check:sync·typecheck·test 통과
 *   2. 서버 묶음(npm run release), APK(npm run build:android), PC 설치 파일(npm run build:desktop) 빌드
 *   3. 태그를 달아 푸시하고 gh release create 로 파일을 올린다
 *
 * 먼저 버전을 올린다: npm run version:set -- <버전> → 릴리즈 노트 작성 → 커밋·푸시.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN_FILE, missingKeyMessage, readPin, readSigning } from './android-signing.mjs';
import { spawnNpm } from './run-npm.mjs';
import { mismatchedVersions, readVersions } from './versions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const VERSION = readJson('package.json').version;
const TAG = `v${VERSION}`;
const NOTES = path.join(ROOT, 'docs', 'releases', `${TAG}.md`);
const isWindows = process.platform === 'win32';
const ARCHIVE = path.join(ROOT, 'release', `listup-${VERSION}.${isWindows ? 'zip' : 'tar.gz'}`);
const APK = path.join(ROOT, 'release', `listup-${VERSION}-android.apk`);
const SETUP = path.join(ROOT, 'release', `listup-${VERSION}-windows-setup.exe`);
// PC 앱 자동 업데이트(desktop/src/updater.ts)가 읽는 것. latest.yml 은 GitHub 에 그 이름 그대로 올라가야 한다.
const BLOCKMAP = `${SETUP}.blockmap`;
const LATEST_YML = path.join(ROOT, 'release', `listup-${VERSION}-latest.yml`);

// 설치된 앱이 자동 업데이트로 받아 가므로, CI 가 빨간 커밋은 올리지 않는다. 급할 때만 이걸로 건너뛴다.
const SKIP_CI = process.argv.slice(2).includes('--skip-ci');

const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n릴리즈를 올리지 않았습니다: ${m}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const REPO = git('remote', 'get-url', 'origin').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 실패 (${code})`))));
  });
}
function runNpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} 실패 (${code})`))));
  });
}

// ---------------------------------------------------------------------------
// 1. 확인 — 하나라도 어긋나면 아무것도 올리지 않는다
// ---------------------------------------------------------------------------
say(`ListUp ${TAG} 릴리즈를 올립니다.\n`);

try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  fail('gh 에 로그인돼 있지 않습니다 (gh auth login).');
}

if (git('status', '--porcelain')) fail('커밋하지 않은 변경이 있습니다. 릴리즈는 커밋된 코드로만 만듭니다.');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('main 브랜치에서만 올립니다.');
git('fetch', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main 이 원격과 다릅니다. 먼저 푸시하세요.');
if (git('tag', '--list', TAG)) fail(`태그 ${TAG} 가 이미 있습니다. 버전을 올리세요 (npm run version:set -- <버전>).`);
if (!fs.existsSync(NOTES)) fail(`릴리즈 노트가 없습니다: ${path.relative(ROOT, NOTES)}`);
// PC 설치 파일은 Windows 에서만 만든다(electron-builder NSIS).
if (!isWindows) fail('PC 설치 파일(Windows)을 만들 수 없는 OS 입니다. Windows 에서 올려 주세요.');

// 안드로이드 서명 키 — 오래 걸리는 빌드 전에 본다. 지문이 맞는지는 build:android 가 다시 확인한다.
// 릴리즈는 늘 고정된 정식 키로만 낸다(새 키로 낸 APK 는 폰의 기존 앱 위에 덮어 설치되지 않는다).
try {
  const pin = readPin();
  if (!pin) {
    fail(
      `정식 서명 키의 지문이 고정돼 있지 않습니다 (${path.relative(ROOT, PIN_FILE)}).\n` +
        '지난 릴리즈의 APK 로 고정하세요: npm run build:android -- --pin-from <APK>',
    );
  }
  if (!readSigning()) fail(missingKeyMessage(pin));
} catch (err) {
  fail(err.message);
}

const mismatched = mismatchedVersions(readVersions(ROOT), VERSION);
if (mismatched.length) {
  fail(`버전이 어긋납니다: ${mismatched.map(([f, v]) => `${f}=${v}`).join(', ')} (npm run version:set -- ${VERSION})`);
}

// 이 커밋의 CI — 위에서 HEAD 가 origin/main 과 같다고 봤으므로 푸시로 돈 CI 가 바로 이 커밋 것이다.
// e2e(웹 흐름)는 로컬에서 돌리지 않고 여기서만 본다. 진행 중·취소·실패·결과 없음은 모두 멈춘다.
if (SKIP_CI) {
  console.warn(
    '\n' + '!'.repeat(72) + '\n' +
      '!! --skip-ci: CI 결과를 확인하지 않고 올립니다.\n' +
      '!! e2e 가 깨진 커밋이어도 그대로 배포되고, 설치된 앱이 자동 업데이트로 받아 갑니다.\n' +
      '!'.repeat(72) + '\n',
  );
} else {
  const sha = git('rev-parse', 'HEAD');
  let runs;
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/commits/${sha}/check-runs?per_page=100`], { cwd: ROOT, encoding: 'utf8' });
    runs = JSON.parse(out).check_runs ?? [];
  } catch {
    fail('CI 결과를 가져오지 못했습니다 (위 gh 출력 참고). 네트워크를 확인하거나, 꼭 올려야 하면 --skip-ci.');
  }
  const url = `https://github.com/${REPO}/commit/${sha}`;
  if (!runs.length) fail(`이 커밋(${sha.slice(0, 7)})에 CI 결과가 없습니다. 방금 푸시했으면 CI 가 끝난 뒤 다시 하세요: ${url}`);
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length) fail(`CI 가 아직 돌고 있습니다 (${pending.map((r) => r.name).join(', ')}). 끝난 뒤 다시 하세요: ${url}`);
  // skipped 는 조건(if:)으로 일부러 안 돈 작업이라 통과로 본다.
  const bad = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped');
  if (bad.length) fail(`CI 가 녹색이 아닙니다: ${bad.map((r) => `${r.name}=${r.conclusion}`).join(', ')} — ${url}`);
  say(`CI 통과: ${runs.map((r) => r.name).join(', ')} (${sha.slice(0, 7)})`);
}

// 로컬 검사 — CI 와 같은 순서(e2e 제외). 빌드보다 훨씬 빠르니 먼저 돌려 실패를 일찍 본다.
for (const script of ['check:sync', 'typecheck', 'test']) {
  try {
    await runNpm(['run', script]);
  } catch (err) {
    fail(err.message);
  }
}

// ---------------------------------------------------------------------------
// 2. 빌드
// ---------------------------------------------------------------------------
await runNpm(['run', 'release']);
if (!fs.existsSync(ARCHIVE)) fail(`서버 묶음이 없습니다: ${ARCHIVE}`);
await runNpm(['run', 'build:android']);
if (!fs.existsSync(APK)) fail(`APK 가 없습니다: ${APK}`);
await runNpm(['run', 'build:desktop']);
if (!fs.existsSync(SETUP)) fail(`PC 설치 파일이 없습니다: ${SETUP}`);
for (const file of [BLOCKMAP, LATEST_YML]) if (!fs.existsSync(file)) fail(`PC 앱 업데이트 정보가 없습니다: ${file}`);
// latest.yml 이 가리키는 설치 파일이 이번 것인지 — 이름이 어긋나면 자동 업데이트가 받을 파일을 못 찾는다.
if (!fs.readFileSync(LATEST_YML, 'utf8').includes(`path: ${path.basename(SETUP)}`)) {
  fail(`latest.yml 이 ${path.basename(SETUP)} 를 가리키지 않습니다.`);
}
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), `listup-release-${VERSION}-`));
const LATEST_UPLOAD = path.join(uploadDir, 'latest.yml');
fs.copyFileSync(LATEST_YML, LATEST_UPLOAD);
// 빌드가 추적 중인 파일을 바꿨다면(되돌리지 못한 prebuild 변경 등) 태그와 코드가 어긋난다.
if (git('status', '--porcelain')) fail('빌드가 추적 중인 파일을 바꿨습니다. git status 를 확인하세요.');

// ---------------------------------------------------------------------------
// 3. 태그와 릴리즈
// ---------------------------------------------------------------------------
say(`\n태그 ${TAG} 를 달고 올립니다…`);
git('tag', '-a', TAG, '-m', `ListUp ${VERSION}`);
git('push', 'origin', TAG);
await run('gh', ['release', 'create', TAG, ARCHIVE, APK, SETUP, BLOCKMAP, LATEST_UPLOAD, '--title', `ListUp ${VERSION}`, '--notes-file', NOTES]);

say(`\n완료: https://github.com/${REPO}/releases/tag/${TAG}`);
