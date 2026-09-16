/**
 * GitHub 릴리즈를 올린다 — 서버 묶음, 안드로이드 APK, PC 설치 파일을 함께.
 *
 *   npm run release:publish
 *
 * 설치형 클라이언트는 GitHub 의 최신 릴리즈를 보고 업데이트를 제안하므로(app/src/lib/updates.ts),
 * 릴리즈는 이 명령으로만 올려 태그·버전·파일이 어긋나지 않게 한다.
 *
 * 하는 일
 *   1. 확인 — gh 로그인, 작업 트리 깨끗함, main 이 원격과 같음(푸시됨), 태그 v<버전> 이 아직 없음,
 *      릴리즈 노트 docs/releases/v<버전>.md 가 있음, 버전이 모든 곳에서 같음
 *   2. 서버 묶음(npm run release), APK(npm run build:android), PC 설치 파일(npm run build:desktop) 빌드
 *   3. 태그를 달아 푸시하고 gh release create 로 파일을 올린다
 *
 * 먼저 버전을 올린다: npm run version:set -- <버전> → 릴리즈 노트 작성 → 커밋·푸시.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNpm } from './run-npm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const VERSION = readJson('package.json').version;
const TAG = `v${VERSION}`;
const NOTES = path.join(ROOT, 'docs', 'releases', `${TAG}.md`);
const isWindows = process.platform === 'win32';
const ARCHIVE = path.join(ROOT, 'release', `listup-${VERSION}.${isWindows ? 'zip' : 'tar.gz'}`);
const APK = path.join(ROOT, 'release', `listup-${VERSION}-android.apk`);
const SETUP = path.join(ROOT, 'release', `listup-${VERSION}-windows-setup.exe`);

const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n릴리즈를 올리지 않았습니다: ${m}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

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

const versions = {
  'app/package.json': readJson('app/package.json').version,
  'server/package.json': readJson('server/package.json').version,
  'shared/package.json': readJson('shared/package.json').version,
  'desktop/package.json': readJson('desktop/package.json').version,
  'app/app.json': readJson('app/app.json').expo.version,
};
const mismatched = Object.entries(versions).filter(([, v]) => v !== VERSION);
if (mismatched.length) {
  fail(`버전이 어긋납니다: ${mismatched.map(([f, v]) => `${f}=${v}`).join(', ')} (npm run version:set -- ${VERSION})`);
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
// 빌드가 추적 중인 파일을 바꿨다면(되돌리지 못한 prebuild 변경 등) 태그와 코드가 어긋난다.
if (git('status', '--porcelain')) fail('빌드가 추적 중인 파일을 바꿨습니다. git status 를 확인하세요.');

// ---------------------------------------------------------------------------
// 3. 태그와 릴리즈
// ---------------------------------------------------------------------------
say(`\n태그 ${TAG} 를 달고 올립니다…`);
git('tag', '-a', TAG, '-m', `ListUp ${VERSION}`);
git('push', 'origin', TAG);
await run('gh', ['release', 'create', TAG, ARCHIVE, APK, SETUP, '--title', `ListUp ${VERSION}`, '--notes-file', NOTES]);

say(`\n완료: https://github.com/${git('remote', 'get-url', 'origin').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '')}/releases/tag/${TAG}`);
