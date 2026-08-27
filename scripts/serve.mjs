/**
 * ListUp 을 켠다. 어느 OS 에서든 이 하나로 끝난다.
 *
 *   npm run serve              서버만 (이 PC·같은 공유기에서 접속)
 *   npm run serve -- --tunnel  + 공개 주소 (방식은 tunnel.mjs 가 판별)
 *   npm run serve -- --check   무엇이 준비됐는지만 보고 끝
 *
 * 하는 일: 서명 키 챙기기 → 웹 빌드(필요하면) → 서버 켜고 뜰 때까지 기다리기
 * → 터널 열기 → 주소와 QR 코드 보여주기.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { spawnNpm } from './run-npm.mjs';
import { ROOT, describe, inspect } from './tunnel.mjs';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const PORT = Number(flag('port', process.env.LISTUP_PORT ?? 4000));
const DATA_DIR = process.env.LISTUP_DATA_DIR ?? path.join(ROOT, 'server', 'data');
const WEB_DIR = path.join(ROOT, 'app', 'dist');
const API_URL_STAMP = path.join(WEB_DIR, '.listup-api-url');
const WEB_API_URL = '/'; // 웹은 서버와 같은 주소를 쓴다

const say = (msg) => console.log(msg);

// ---------------------------------------------------------------------------
// --check: 진단만
// ---------------------------------------------------------------------------
if (has('check')) {
  say(describe());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. 서명 키 — 없으면 만들어 둔다. 없이 켜면 재시작마다 전원 로그아웃된다.
// ---------------------------------------------------------------------------
const secretFile = path.join(DATA_DIR, 'auth-secret.txt');
if (!process.env.LISTUP_AUTH_SECRET) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, `${crypto.randomBytes(32).toString('hex')}\n`);
    say(`서명 키를 새로 만들었습니다: ${secretFile}`);
    say('  이 파일이 바뀌면 모두 로그아웃됩니다. 지우거나 옮기지 마세요.\n');
  }
  process.env.LISTUP_AUTH_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}

// ---------------------------------------------------------------------------
// 2. 웹 빌드 — 없거나 다른 주소로 만들어졌으면 다시 만든다.
// ---------------------------------------------------------------------------
function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, { stdio: 'inherit', cwd: ROOT, ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args[1] ?? ''} 실패 (${code})`));
    });
  });
}

const builtFor = fs.existsSync(API_URL_STAMP) ? fs.readFileSync(API_URL_STAMP, 'utf8').trim() : null;
const needBuild = !fs.existsSync(path.join(WEB_DIR, 'index.html')) || builtFor !== WEB_API_URL;
// 배포 묶음에는 웹이 이미 들어 있고 앱 워크스페이스가 없다 — 빌드를 시도하면 안 된다.
const canBuild = fs.existsSync(path.join(ROOT, 'app', 'package.json'));
if (needBuild && !canBuild) {
  console.error('웹 빌드 결과(app/dist)가 없거나 다른 주소로 만들어졌습니다.');
  console.error('이 묶음에는 앱 소스가 없어 다시 빌드할 수 없습니다 — 배포본을 다시 받으세요.');
  process.exit(1);
}
if (needBuild && !has('no-build')) {
  say('웹을 빌드합니다 (처음이면 몇 분 걸립니다)…');
  await runNpm(['run', 'build:web', '--workspace', '@listup/app', '--', '--clear'], {
    env: { ...process.env, EXPO_PUBLIC_LISTUP_API_URL: WEB_API_URL },
  });
  fs.writeFileSync(API_URL_STAMP, `${WEB_API_URL}\n`);
  say('');
}

// ---------------------------------------------------------------------------
// 3. 서버를 켜고 뜰 때까지 기다린다.
// ---------------------------------------------------------------------------
const server = spawnNpm(['run', 'start', '--workspace', '@listup/server'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' },
});

const health = `http://localhost:${PORT}/api/health`;
say(`서버가 뜨기를 기다립니다… (${health})`);

let up = false;
for (let i = 0; i < 90 && !up; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
    up = res.ok;
  } catch {
    // 아직 안 떴다.
  }
}
if (!up) {
  console.error('\n서버가 90초 안에 뜨지 않았습니다. 위 오류를 확인하세요.');
  server.kill();
  process.exit(1);
}
say('서버 준비 완료.\n');

// ---------------------------------------------------------------------------
// 4. 공개 주소 — --tunnel 일 때만.
// ---------------------------------------------------------------------------
let tunnel = null;

function announce(url, note) {
  say('');
  say(`  ${url}`);
  if (note) say(`  ${note}`);
  say('');
  qrcode.generate(url, { small: true }, (qr) => say(qr));
  say('  폰에서 이 QR 을 찍으면 바로 열립니다.\n');
}

if (has('tunnel')) {
  const state = inspect();
  if (state.blockers.length > 0) {
    console.error(`공개 방식(${state.mode})을 쓸 수 없습니다:`);
    for (const b of state.blockers) console.error(`  - ${b}`);
    console.error('\n`npm run serve -- --check` 로 상태를 볼 수 있습니다.');
    server.kill();
    process.exit(1);
  }

  if (state.mode === 'quick') {
    say('Cloudflare 빠른 터널을 엽니다 (주소가 매번 바뀝니다)…');
    tunnel = spawn(state.cloudflared, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate']);
    let announced = false;
    const watch = (chunk) => {
      const text = String(chunk);
      const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found && !announced) {
        announced = true;
        announce(found[0], '임시 주소입니다. 이 창을 닫으면 사라집니다.');
      }
    };
    tunnel.stdout.on('data', watch);
    tunnel.stderr.on('data', watch);
  } else if (state.mode === 'named') {
    say(`Cloudflare 터널 "${state.config.tunnel}" 를 엽니다…`);
    tunnel = spawn(state.cloudflared, [
      'tunnel', 'run', '--url', `http://localhost:${PORT}`, state.config.tunnel,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    announce(`https://${state.hostname}`, '고정 주소입니다.');
  } else if (state.mode === 'tailscale') {
    say('Tailscale Funnel 을 엽니다…');
    tunnel = spawn(state.tailscale, ['funnel', String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'] });
    announce(`https://${state.hostname}`, '고정 주소입니다.');
  }
} else {
  announce(`http://localhost:${PORT}`, '이 PC 에서만 열립니다. 밖에서 쓰려면 --tunnel 을 붙이세요.');
}

// ---------------------------------------------------------------------------
// 5. 정리
// ---------------------------------------------------------------------------
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  tunnel?.kill();
  server.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  if (!stopping) {
    console.error(`\n서버가 멈췄습니다 (${code}).`);
    stop();
  }
});
