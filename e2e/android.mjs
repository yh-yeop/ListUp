/**
 * 안드로이드 흐름 테스트 — 에뮬레이터에 시험용 APK 를 깔고 실제 앱을 조작한다(adb + uiautomator).
 * 웹 흐름 테스트(e2e/run.mjs)로는 볼 수 없는 네이티브 경로를 본다: 앱 안 업데이트(APK 받기 → 설치 화면),
 * 네이티브 대화상자·토스트, 아이디 가입, 버전 표시.
 *
 *   npm run test:android              시험용 APK 가 없으면 만들고(몇 분) 돌린다
 *   npm run test:android -- --build   시험용 APK 를 새로 만들고 돌린다
 *   npm run test:android -- --keep    끝나도 에뮬레이터를 끄지 않는다
 *
 * 시험용 APK(release/listup-<버전>-android-test.apk)는 정식 APK 와 같은 키로 서명하고, 업데이트 확인이 GitHub 대신
 * 이 스크립트가 띄우는 가짜 릴리즈(FEED_PORT)를 본다. 에뮬레이터는 이 테스트 전용 AVD(ListUp_E2E)를 만들어 쓴다 —
 * 다른 프로젝트의 AVD 를 건드리지 않게.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const say = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'app.json'), 'utf8')).expo.version;
const PACKAGE = 'com.listup.app';
const AVD = process.env.LISTUP_ANDROID_AVD ?? 'ListUp_E2E';
const SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64';
const EMULATOR_PORT = 5584;
const SERIAL = `emulator-${EMULATOR_PORT}`;
/** 시험용 APK 에 박는 가짜 릴리즈 주소의 포트 — 에뮬레이터에서 호스트는 10.0.2.2. */
const FEED_PORT = 47123;
const FEED_URL = `http://10.0.2.2:${FEED_PORT}/latest`;
const TEST_APK = path.join(ROOT, 'release', `listup-${VERSION}-android-test.apk`);

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const exe = (p) => (process.platform === 'win32' ? `${p}.exe` : p);
const ADB = path.join(SDK, 'platform-tools', exe('adb'));
const EMULATOR = path.join(SDK, 'emulator', exe('emulator'));

// ---------------------------------------------------------------------------
// 도구
// ---------------------------------------------------------------------------
function adb(args, { allowFail = false, input } = {}) {
  const out = spawnSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  if (out.status !== 0 && !allowFail) throw new Error(`adb ${args.join(' ')} 실패\n${out.stderr || out.stdout}`);
  return (out.stdout ?? '').trim();
}

function findJavaHome() {
  for (const base of ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Java']) {
    if (!fs.existsSync(base)) continue;
    const jdk = fs.readdirSync(base).find((name) => name.includes('17'));
    if (jdk) return path.join(base, jdk);
  }
  return process.env.JAVA_HOME;
}

function sdkTool(name) {
  const dir = path.join(SDK, 'cmdline-tools');
  for (const version of ['latest', ...(fs.existsSync(dir) ? fs.readdirSync(dir) : [])]) {
    const tool = path.join(dir, version, 'bin', process.platform === 'win32' ? `${name}.bat` : name);
    if (fs.existsSync(tool)) return tool;
  }
  throw new Error(`${name} 을 찾지 못했습니다 (Android SDK cmdline-tools).`);
}

function runBat(tool, args, input) {
  const env = { ...process.env, JAVA_HOME: findJavaHome() };
  return process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${tool}" ${args.map((a) => `"${a}"`).join(' ')}"`], {
        encoding: 'utf8',
        env,
        input,
        windowsVerbatimArguments: true,
      })
    : spawnSync(tool, args, { encoding: 'utf8', env, input });
}

/** 이 테스트 전용 AVD 가 없으면 만든다(시스템 이미지가 없으면 받는다). */
function ensureAvd() {
  const list = spawnSync(EMULATOR, ['-list-avds'], { encoding: 'utf8' }).stdout ?? '';
  if (list.split(/\r?\n/).includes(AVD)) return;
  say(`에뮬레이터(${AVD})를 만듭니다…`);
  const imageDir = path.join(SDK, ...SYSTEM_IMAGE.split(';'));
  if (!fs.existsSync(imageDir)) {
    say(`시스템 이미지를 받습니다: ${SYSTEM_IMAGE}`);
    const got = runBat(sdkTool('sdkmanager'), [SYSTEM_IMAGE], 'y\n'.repeat(20));
    if (got.status !== 0) throw new Error(`시스템 이미지를 받지 못했습니다.\n${got.stderr || got.stdout}`);
  }
  const made = runBat(sdkTool('avdmanager'), ['create', 'avd', '-n', AVD, '-k', SYSTEM_IMAGE, '-d', 'pixel_6'], 'no\n');
  if (made.status !== 0) throw new Error(`AVD 를 만들지 못했습니다.\n${made.stderr || made.stdout}`);
}

/** 에뮬레이터를 띄워 부팅이 끝날 때까지 기다린다. 이미 떠 있으면 그대로 쓴다. 띄웠으면 true. */
async function startEmulator() {
  const devices = spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout ?? '';
  if (devices.includes(SERIAL)) return false;
  ensureAvd();
  say(`에뮬레이터를 띄웁니다 (${AVD}, 창 없이)…`);
  // 에뮬레이터 자신의 로그 — 도중에 꺼지면 이유가 여기 남는다.
  const logFile = path.join(ROOT, 'e2e', '.cache', 'emulator.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'w');
  const child = spawn(
    EMULATOR,
    ['-avd', AVD, '-port', String(EMULATOR_PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect', '-memory', '3072'],
    { detached: true, stdio: ['ignore', log, log] },
  );
  child.unref();
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    if (adb(['shell', 'getprop', 'sys.boot_completed'], { allowFail: true }) === '1') {
      // 애니메이션을 끄면 화면 읽기가 덜 흔들린다.
      for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
        adb(['shell', 'settings', 'put', 'global', key, '0'], { allowFail: true });
      }
      return true;
    }
    await sleep(2000);
  }
  throw new Error('에뮬레이터가 5분 안에 켜지지 않았습니다.');
}

// ---------------------------------------------------------------------------
// 화면 읽기·누르기 (uiautomator)
// ---------------------------------------------------------------------------
function decode(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 지금 화면의 요소들. */
function dump() {
  const xml = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFail: true });
  const nodes = [];
  for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attr = (name) => decode(match[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '');
    const bounds = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      cls: attr('class'),
      pkg: attr('package'),
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    });
  }
  return nodes;
}

const matches = (node, query) =>
  typeof query === 'function' ? query(node) : query instanceof RegExp ? query.test(node.text) || query.test(node.desc) : node.text === query || node.desc === query;

async function waitFor(query, { timeout = 30_000, label } = {}) {
  const until = Date.now() + timeout;
  let last = [];
  while (Date.now() < until) {
    last = dump();
    const found = last.find((node) => matches(node, query));
    if (found) return found;
    await sleep(700);
  }
  const visible = last.map((n) => n.text || n.desc).filter(Boolean).slice(0, 25).join(' | ');
  const alive = (spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout ?? '').includes(SERIAL);
  const focus = alive
    ? adb(['shell', 'dumpsys', 'window'], { allowFail: true }).match(/mCurrentFocus=[^\n]*/)?.[0]
    : '에뮬레이터가 꺼짐 (e2e/.cache/emulator.log)';
  throw new Error(`화면에서 찾지 못했습니다: ${label ?? query}\n    보이는 것: ${visible || '(없음)'}\n    창: ${focus}`);
}

const tapAt = (node) => adb(['shell', 'input', 'tap', String(node.x), String(node.y)]);

/** 입력칸이 아닌 것을 누르기 전에 키보드를 닫는다 — 키보드에 가린 버튼을 누르면 키보드 글자가 들어간다. */
async function tap(query, options) {
  await hideKeyboard();
  const node = await waitFor(query, options);
  tapAt(node);
  await sleep(400);
  return node;
}

const keyboardShown = () => adb(['shell', 'dumpsys', 'input_method'], { allowFail: true }).includes('mInputShown=true');

/**
 * 키보드를 닫는다. 입력칸을 누른 직후에는 키보드가 아직 올라오는 중일 수 있어, 잠시 지켜보다 떠 있으면 닫는다.
 * 먼저 ESC(뒤로 가지 않는다). 비밀번호 칸처럼 ESC 를 받지 않는 칸이면 BACK — 키보드가 떠 있을 때의 BACK 은
 * 키보드만 닫는다. 떠 있는 것을 확인했을 때만 보낸다(키보드가 없을 때의 BACK 은 화면을 닫는다).
 */
async function hideKeyboard() {
  let attempts = 0;
  for (let i = 0; i < 6; i += 1) {
    if (keyboardShown()) {
      adb(['shell', 'input', 'keyevent', attempts === 0 ? '111' : '4']);
      attempts += 1;
      await sleep(500);
    } else {
      await sleep(200);
    }
  }
  if (keyboardShown()) throw new Error('키보드가 닫히지 않습니다.');
}

/** n 번째 입력칸에 글자를 넣는다(ASCII 만 — adb input 의 한계). */
async function typeInto(index, text) {
  const fields = (await waitForFields(index + 1)).slice(index, index + 1);
  tapAt(fields[0]);
  await sleep(300);
  adb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  await sleep(300);
  await hideKeyboard();
}

async function waitForFields(count, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const fields = dump().filter((node) => node.cls === 'android.widget.EditText');
    if (fields.length >= count) return fields;
    await sleep(500);
  }
  throw new Error(`입력칸 ${count}개를 찾지 못했습니다.`);
}

// ---------------------------------------------------------------------------
// 서버들 — ListUp 서버(임시 데이터)와 가짜 릴리즈
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startListUp() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-android-e2e-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    stdio: 'ignore',
    env: {
      ...process.env,
      LISTUP_PORT: String(port),
      LISTUP_DATA_DIR: dataDir,
      LISTUP_WEB_DIR: path.join(dataDir, 'no-web'),
      LISTUP_LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
    },
  });
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(300);
  }
  return { url, port, stop: () => (child.kill(), fs.rmSync(dataDir, { recursive: true, force: true })) };
}

/** GitHub 대신 — v99.0.0 릴리즈가 있다고 하고, 그 APK 로 시험용 APK 자신을 준다(같은 키라 덮어 설치된다). */
async function startFeed() {
  const served = [];
  const apkName = 'listup-99.0.0-android.apk';
  const server = http.createServer((req, res) => {
    served.push(req.url);
    if (req.url === '/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/yh-yeop/ListUp/releases/tag/v99.0.0',
          assets: [{ name: apkName, browser_download_url: `http://10.0.2.2:${FEED_PORT}/${apkName}` }],
        }),
      );
      return;
    }
    if (req.url === `/${apkName}`) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': fs.statSync(TEST_APK).size });
      fs.createReadStream(TEST_APK).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FEED_PORT, '127.0.0.1', resolve);
  });
  return { served, stop: () => server.close() };
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const t = {
  ok(label) {
    passed += 1;
    say(`  ✓ ${label}`);
  },
  must(cond, label) {
    if (!cond) throw new Error(`실패: ${label}`);
    t.ok(label);
  },
};

const stops = [];
let startedEmulator = false;
try {
  if (argv.includes('--build') || !fs.existsSync(TEST_APK)) {
    say('시험용 APK 를 만듭니다 (몇 분)…');
    const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-android.mjs'), '--test-update-api', FEED_URL], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('시험용 APK 를 만들지 못했습니다.');
  }

  startedEmulator = await startEmulator();
  const listup = await startListUp();
  stops.push(listup.stop);
  const feed = await startFeed();
  stops.push(feed.stop);
  const serverForEmulator = `http://10.0.2.2:${listup.port}`;

  say('\n시험용 APK 를 깝니다…');
  adb(['install', '-r', TEST_APK]);
  adb(['shell', 'pm', 'clear', PACKAGE], { allowFail: true });
  // "이 출처의 앱 설치 허용" — 사람이라면 처음 한 번 설정에서 켠다.
  adb(['shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow']);
  const installedAt = () => adb(['shell', 'dumpsys', 'package', PACKAGE]).match(/lastUpdateTime=([^\n]+)/)?.[1]?.trim();
  const before = installedAt();

  say('\n● 앱 안 업데이트');
  adb(['shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1'], { allowFail: true });
  await waitFor(/새 버전이 있습니다/, { timeout: 60_000 });
  t.must(feed.served.includes('/latest'), '앱을 열면 최신 릴리즈를 묻는다');
  await tap('받아서 설치');
  // 설치 화면 — 같은 키·같은 앱이라 "업데이트"를 묻는다.
  const install = await waitFor((n) => /packageinstaller/.test(n.pkg) && /^(Update|Install|업데이트|설치)$/i.test(n.text), {
    timeout: 120_000,
    label: '설치 화면의 업데이트 버튼',
  });
  t.must(feed.served.some((u) => u.endsWith('.apk')), '새 버전 APK 를 받는다');
  t.ok('다 받으면 시스템 설치 화면을 띄운다');
  tapAt(install);
  const until = Date.now() + 120_000;
  while (Date.now() < until && installedAt() === before) await sleep(1000);
  t.must(installedAt() !== before, '설치 화면에서 업데이트 → 앱이 새로 설치된다');

  // 설치가 끝나면 설치 화면이 "열기"를 묻는다 — 사람처럼 눌러 새 버전을 연다.
  await tap((n) => /packageinstaller/.test(n.pkg) && /^(Open|열기)$/i.test(n.text), { timeout: 30_000, label: '설치 완료 화면의 열기' });
  t.ok('설치가 끝나면 열기로 새 버전이 뜬다');

  say('\n● 버전·서버·아이디 가입');
  await waitFor(`ListUp 안드로이드 앱 v${VERSION} · AGPL-3.0`, { timeout: 60_000 });
  t.ok(`서버 목록에 안드로이드 앱 버전 (v${VERSION})`);
  t.must(!dump().some((n) => /새 버전이 있습니다/.test(n.text)), '같은 버전은 다시 묻지 않는다');

  await tap('서버 추가');
  await typeInto(1, serverForEmulator);
  await tap('연결 확인');
  await waitFor(/연결을 확인했습니다/);
  await tap('저장하고 들어가기');
  await tap('회원가입', { timeout: 30_000 });
  await typeInto(0, 'emu');
  await typeInto(1, 'emu_user1');
  await typeInto(2, 'password-1');
  await tap('가입하고 시작하기');
  await waitFor('emu 님으로 로그인됨', { timeout: 30_000 });
  t.ok('에뮬레이터에서 서버 추가 → 아이디로 가입');

  say('\n● 대화상자·토스트');
  const login = await api(listup.url, '/api/auth/login', { email: 'EMU_USER1', password: 'password-1' });
  t.must(login.status === 200, '대문자로도 같은 아이디로 로그인(API)');
  const token = login.json.token;
  const repo = (await api(listup.url, '/api/repos', { name: 'emu-repo' }, token)).json.repo;
  const { upload } = (await api(listup.url, `/api/repos/${repo.id}/uploads`, { name: 'a.txt', size: 5 }, token)).json;
  await fetch(`${listup.url}/api/uploads/${upload.id}?offset=0`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('hello'),
  });
  const { blob } = (await api(listup.url, `/api/uploads/${upload.id}/complete`, {}, token)).json;
  await api(listup.url, `/api/repos/${repo.id}/files/commit`, { changes: [{ path: 'a.txt', blobHash: blob.hash }] }, token);
  // 목록을 당겨서 새로고침.
  adb(['shell', 'input', 'swipe', '540', '700', '540', '1700', '400']);
  await tap(/emu-repo/, { timeout: 30_000 });
  // 행에는 받기와 ⋯ 만 — 삭제는 ⋯ 를 펼쳐야 나온다.
  await tap('a.txt 더보기', { timeout: 30_000 });
  await tap('a.txt 삭제', { timeout: 10_000 });
  await waitFor('이 파일을 지울까요?');
  t.ok('지우기 전에 네이티브 대화상자로 묻는다');
  await tap('삭제');
  await waitFor('지웠습니다.', { timeout: 15_000 });
  t.ok('지운 뒤 화면 안 토스트');
} catch (err) {
  failed += 1;
  say(`  ✗ ${err instanceof Error ? err.message : err}`);
  const shot = path.join(ROOT, 'e2e', '.cache', 'failures', 'android.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  const png = spawnSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
  if (png.status === 0 && png.stdout?.length) {
    fs.writeFileSync(shot, png.stdout);
    say(`    화면: ${path.relative(ROOT, shot)}`);
  }
} finally {
  for (const stop of stops.reverse()) {
    try {
      await stop();
    } catch {
      // 정리 중 오류는 결과와 무관
    }
  }
  if (startedEmulator && !argv.includes('--keep')) spawnSync(ADB, ['-s', SERIAL, 'emu', 'kill']);
}

say(`\n${failed === 0 ? '모두 통과' : '실패'} — 확인 ${passed}개`);
process.exit(failed === 0 ? 0 : 1);
