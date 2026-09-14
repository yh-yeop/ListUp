/**
 * 웹 흐름 테스트 — 실제 브라우저로 앱을 조작해 서버 목록·클라이언트 모드·로그인 저장·버전 확인·
 * 업데이트 알림 같은 흐름을 확인한다. 서버 테스트(npm test)는 HTTP 수준이고, 이쪽은 화면 수준이다.
 *
 *   npm run test:e2e                     전부
 *   npm run test:e2e -- credentials      파일 이름에 들어간 스펙만
 *   npm run test:e2e -- --no-build       지난번에 빌드한 웹(e2e/.cache)을 다시 쓴다
 *
 * 하는 일: 웹을 서버 모드와 클라이언트 모드로 빌드 → 빈 포트에 서버 A·B(임시 DB)를 띄우고, 클라이언트
 * 모드 웹용 정적 서버(/api 가 없다 — 같은 주소로 요청이 새면 드러나게)와 API 버전이 다른 가짜 서버를
 * 이 프로세스 안에 띄운다 → 스펙을 차례로 돌린다. 쓰고 있는 서버(4000 등)와 포트가 겹치지 않는다.
 *
 * 브라우저: E2E_BROWSER_CHANNEL (Windows 기본 msedge — 설치돼 있다. 그 밖에는 `npx playwright-core
 * install chromium` 으로 받은 Chromium).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'e2e', '.cache');
const SPECS = path.join(ROOT, 'e2e', 'specs');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'app.json'), 'utf8')).expo.version;

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const filters = argv.filter((a) => !a.startsWith('--'));
const say = (m) => console.log(m);

// ---------------------------------------------------------------------------
// 웹 빌드
// ---------------------------------------------------------------------------
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 실패 (${code})\n${tail}`))));
  });
}

async function buildWeb(outDir, mode) {
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_LISTUP_API_URL;
  delete env.EXPO_PUBLIC_LISTUP_CLIENT;
  if (mode === 'server') env.EXPO_PUBLIC_LISTUP_API_URL = '/';
  else env.EXPO_PUBLIC_LISTUP_CLIENT = '1';
  const expoCli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
  await run(process.execPath, [expoCli, 'export', '--platform', 'web', '--clear', '--output-dir', outDir], {
    cwd: path.join(ROOT, 'app'),
    env: { ...env, CI: '1' },
  });
}

// ---------------------------------------------------------------------------
// 서버들
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

async function waitFor(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 아직 안 떴다
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`응답이 없습니다: ${url}`);
}

/** ListUp 서버를 임시 데이터 폴더로 띄운다. */
async function startListUp({ webDir }) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      LISTUP_PORT: String(port),
      LISTUP_DATA_DIR: dataDir,
      LISTUP_WEB_DIR: webDir ?? path.join(dataDir, 'no-web'),
      LISTUP_LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr = (stderr + c.toString()).slice(-2000);
  });
  const url = `http://localhost:${port}`;
  try {
    await waitFor(`${url}/api/health`);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n${stderr}`);
  }
  return {
    url,
    dataDir,
    stop: () => {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 서버 운영자가 하듯 재설정 코드를 발급한다 (npm run reset-password 와 같은 명령). 출력 전체와 코드. */
function issueResetCode(server, email) {
  const out = spawnSync(process.execPath, ['--import', 'tsx', 'src/reset-password.ts', email], {
    cwd: path.join(ROOT, 'server'),
    encoding: 'utf8',
    env: { ...process.env, LISTUP_DATA_DIR: server.dataDir, LISTUP_LOG_LEVEL: 'warn', NODE_ENV: 'test' },
  });
  const text = `${out.stdout}${out.stderr}`;
  return { status: out.status, text, code: text.match(/재설정 코드: ([A-Z0-9]{5}-[A-Z0-9]{5})/)?.[1] ?? null };
}

/** 클라이언트 모드 웹을 ListUp 과 무관한 정적 서버로. /api 요청은 새어 나온 것이라 기록한다. */
async function startStatic(root, leaks) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname.startsWith('/api/')) {
      leaks.push(`${req.method} ${pathname}`);
      res.writeHead(404).end();
      return;
    }
    let file = path.join(root, pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://localhost:${port}`, stop: () => server.close() };
}

/** /api/health 만 답하는 가짜 ListUp 서버. API 버전이 다른 서버를 흉내 낸다. */
async function startMockHealth(body) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.url === '/api/health') res.writeHead(200, headers).end(JSON.stringify(body));
    else res.writeHead(404, headers).end('{}');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://localhost:${port}`, stop: () => server.close() };
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
const stops = [];
let failed = 0;
let passed = 0;

try {
  const specFiles = fs
    .readdirSync(SPECS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
    .sort();
  if (specFiles.length === 0) throw new Error(`스펙이 없습니다: ${filters.join(', ')}`);

  const serverWeb = path.join(CACHE, 'server-web');
  const clientWeb = path.join(CACHE, 'client-web');
  if (noBuild && fs.existsSync(path.join(serverWeb, 'index.html')) && fs.existsSync(path.join(clientWeb, 'index.html'))) {
    say('지난번 웹 빌드를 씁니다 (e2e/.cache).');
  } else {
    say('웹을 빌드합니다 — 서버 모드…');
    await buildWeb(serverWeb, 'server');
    say('웹을 빌드합니다 — 클라이언트 모드…');
    await buildWeb(clientWeb, 'client');
  }

  say('서버를 띄웁니다…');
  const leaks = [];
  const [A, B] = await Promise.all([startListUp({ webDir: serverWeb }), startListUp({})]);
  stops.push(A.stop, B.stop);
  const C = await startStatic(clientWeb, leaks);
  const NEWER = await startMockHealth({ ok: true, time: 0, maxUploadBytes: 1, apiVersion: 2, version: '9.0.0' });
  const LEGACY = await startMockHealth({ ok: true, time: 0, maxUploadBytes: 1 });
  const V110 = await startMockHealth({ ok: true, time: 0, maxUploadBytes: 1, apiVersion: 1, version: '1.1.0' });
  const OLDER = await startMockHealth({ ok: true, time: 0, maxUploadBytes: 1, apiVersion: 0, version: '0.9.0' });
  stops.push(C.stop, NEWER.stop, LEGACY.stop, V110.stop, OLDER.stop);
  const DEAD = `http://localhost:${await freePort()}`;

  const channel = process.env.E2E_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
  const browser = await chromium.launch({ channel, headless: true });
  stops.push(() => browser.close());

  for (const file of specFiles) {
    const name = file.replace(/\.mjs$/, '');
    const spec = await import(pathToFileURL(path.join(SPECS, file)).href);
    const pages = [];
    const pageErrors = [];
    let count = 0;

    /**
     * 브라우저 컨텍스트. GitHub API 는 늘 가짜로 가로챈다 — 테스트가 실제 GitHub 에 묻지 않게.
     * latest: 최신 릴리즈 버전(기본은 앱 버전 — 업데이트 제안이 뜨지 않는다).
     */
    const newContext = async ({ latest = APP_VERSION, githubStatus = 200 } = {}) => {
      const ctx = await browser.newContext();
      const github = { calls: [], opened: [] };
      await ctx.route('https://api.github.com/**', (route) => {
        github.calls.push(route.request().url());
        if (githubStatus !== 200) return route.fulfill({ status: githubStatus, body: '{}' });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ tag_name: `v${latest}`, html_url: `https://github.com/yh-yeop/ListUp/releases/tag/v${latest}` }),
        });
      });
      // 릴리즈 페이지는 실제로 열지 않고 어디로 가려 했는지만 남긴다.
      await ctx.route('https://github.com/**', (route) => {
        github.opened.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>release</title>' });
      });
      ctx.on('page', (page) => {
        pages.push(page);
        page.on('pageerror', (e) => pageErrors.push(e.message));
      });
      stops.push(() => ctx.close().catch(() => {}));
      return Object.assign(ctx, { github });
    };

    const t = {
      ok(label) {
        count += 1;
        console.log(`  ✓ ${label}`);
      },
      must(cond, label) {
        if (!cond) throw new Error(`실패: ${label}`);
        t.ok(label);
      },
    };
    const env = {
      A: A.url,
      B: B.url,
      C: C.url,
      NEWER: NEWER.url,
      LEGACY: LEGACY.url,
      V110: V110.url,
      OLDER: OLDER.url,
      DEAD,
      leaks,
      appVersion: APP_VERSION,
      issueResetCode: (email) => issueResetCode(A, email),
      run: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      newContext,
    };

    say(`\n● ${spec.title ?? name}`);
    const started = Date.now();
    try {
      await spec.default(t, env);
      passed += count;
      say(`  — ${count}개 통과 (${((Date.now() - started) / 1000).toFixed(0)}초)`);
    } catch (err) {
      failed += 1;
      passed += count;
      console.error(`  ✗ ${err.message.split('\n')[0]}`);
      const last = pages.filter((p) => !p.isClosed()).at(-1);
      if (last) {
        fs.mkdirSync(path.join(CACHE, 'failures'), { recursive: true });
        const shot = path.join(CACHE, 'failures', `${name}.png`);
        await last.screenshot({ path: shot, fullPage: true }).catch(() => {});
        console.error(`    주소: ${last.url()}`);
        console.error(`    화면: ${(await last.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
        console.error(`    캡처: ${path.relative(ROOT, shot)}`);
      }
      if (process.env.E2E_DEBUG) console.error(err.stack);
    }
    if (pageErrors.length) say(`  (페이지 오류 ${pageErrors.length}건: ${pageErrors[0]})`);
  }
} catch (err) {
  failed += 1;
  console.error(`\n실행하지 못했습니다: ${err.message}`);
} finally {
  for (const stop of stops.reverse()) {
    try {
      await stop();
    } catch {
      // 정리 중 오류는 결과에 영향이 없다
    }
  }
}

say(`\n${failed === 0 ? '모두 통과' : `실패한 스펙 ${failed}개`} — 확인 ${passed}개`);
process.exit(failed === 0 ? 0 : 1);
