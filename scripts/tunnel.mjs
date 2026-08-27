/**
 * 공개 주소를 어떻게 낼지 판별하고 준비 상태를 알려준다.
 *
 * 세 가지가 있다.
 *   quick      Cloudflare 빠른 터널. 계정 없이 되지만 주소가 매번 바뀐다 (시험용).
 *   named      Cloudflare 이름 있는 터널. 계정 + **자기 도메인**이 필요하고 주소가 고정된다.
 *   tailscale  Tailscale Funnel. 계정만 있으면 `*.ts.net` 고정 주소를 준다 (도메인 불필요).
 *
 * 고른 방식은 `server/data/tunnel.json` 에 적어 둔다 (데이터 디렉터리라 git 에 올라가지 않는다).
 *
 *   node scripts/tunnel.mjs status      지금 무엇을 쓸 수 있는지
 *   node scripts/tunnel.mjs use <방식>  쓸 방식을 정한다 (quick | named | tailscale)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'server', 'data', 'tunnel.json');

/** cloudflared 실행 파일을 찾는다. PATH 에 없으면 흔한 설치 경로를 본다. */
export function findCloudflared() {
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], {
    encoding: 'utf8',
  });
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
  }
  const guesses =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
          'C:\\Program Files\\cloudflared\\cloudflared.exe',
        ]
      : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];
  return guesses.find((p) => fs.existsSync(p)) ?? null;
}

function findTailscale() {
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tailscale'], {
    encoding: 'utf8',
  });
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
  }
  const guesses =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
      : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
  return guesses.find((p) => fs.existsSync(p)) ?? null;
}

/** Cloudflare 계정 인증(`cloudflared tunnel login`)을 마쳤는지, 만들어 둔 터널이 있는지. */
export function cloudflareState() {
  const dir = path.join(os.homedir(), '.cloudflared');
  const loggedIn = fs.existsSync(path.join(dir, 'cert.pem'));
  let tunnels = [];
  try {
    // 터널을 만들면 <UUID>.json 자격증명 파일이 생긴다.
    tunnels = fs
      .readdirSync(dir)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((name) => name.replace(/\.json$/i, ''));
  } catch {
    // 디렉터리가 없으면 로그인한 적이 없는 것이다.
  }
  return { loggedIn, tunnels };
}

/** Tailscale 이 로그인돼 있으면 이 기기의 고정 주소를 돌려준다. */
export function tailscaleHostname(binary = findTailscale()) {
  if (!binary) return null;
  try {
    const out = execFileSync(binary, ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
    const dns = JSON.parse(out)?.Self?.DNSName;
    return typeof dns === 'string' && dns ? dns.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * 지금 무엇을 쓸 수 있는지 훑는다.
 * `mode` 는 실제로 쓸 방식이고, `blockers` 는 그 방식에 모자란 것들이다.
 */
export function inspect() {
  const config = readConfig();
  const cloudflared = findCloudflared();
  const cf = cloudflareState();
  const tailscale = findTailscale();
  const tsHost = tailscale ? tailscaleHostname(tailscale) : null;

  // 정해 둔 방식이 있으면 그것을, 없으면 준비된 것 중 고정 주소를 우선한다.
  const configured = config.mode;
  const named = cf.loggedIn && cf.tunnels.length > 0 && config.hostname && config.tunnel;
  const mode = configured ?? (named ? 'named' : tsHost ? 'tailscale' : 'quick');

  const blockers = [];
  if (mode === 'quick' || mode === 'named') {
    if (!cloudflared) blockers.push('cloudflared 가 설치돼 있지 않습니다 (winget install Cloudflare.cloudflared).');
  }
  if (mode === 'named') {
    if (!cf.loggedIn) blockers.push('Cloudflare 계정 인증이 필요합니다 (cloudflared tunnel login).');
    if (cf.tunnels.length === 0) blockers.push('만들어 둔 터널이 없습니다 (cloudflared tunnel create listup).');
    if (!config.tunnel) blockers.push('쓸 터널 이름이 정해지지 않았습니다 (tunnel.json 의 tunnel).');
    if (!config.hostname)
      blockers.push('붙일 주소가 정해지지 않았습니다 — 자기 도메인이 있어야 합니다 (cloudflared tunnel route dns).');
  }
  if (mode === 'tailscale') {
    if (!tailscale) blockers.push('tailscale 이 설치돼 있지 않습니다.');
    else if (!tsHost) blockers.push('Tailscale 에 로그인돼 있지 않습니다 (tailscale up).');
  }

  const hostname = mode === 'tailscale' ? tsHost : mode === 'named' ? config.hostname : null;
  return { mode, hostname, blockers, cloudflared, tailscale, cf, tsHost, config };
}

/** 사람이 읽을 상태 표. */
export function describe(state = inspect()) {
  const lines = [];
  const mark = (ok) => (ok ? 'O' : '-');
  lines.push('공개 방식');
  lines.push(`  ${mark(state.cloudflared)} cloudflared  ${state.cloudflared ?? '(없음)'}`);
  lines.push(
    `  ${mark(state.cf.loggedIn)} Cloudflare 계정 인증${state.cf.tunnels.length ? ` · 만들어 둔 터널 ${state.cf.tunnels.length}개` : ''}`,
  );
  lines.push(`  ${mark(state.tsHost)} Tailscale  ${state.tsHost ?? '(없음)'}`);
  lines.push('');
  lines.push(`지금 쓸 방식: ${state.mode}${state.hostname ? ` → https://${state.hostname}` : ''}`);
  if (state.mode === 'quick') {
    lines.push('  주소가 켤 때마다 바뀝니다. 계속 쓰려면 고정 주소로 옮기세요 (README 6번).');
  }
  if (state.blockers.length > 0) {
    lines.push('');
    lines.push('모자란 것:');
    for (const b of state.blockers) lines.push(`  - ${b}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'use') {
    const mode = rest[0];
    if (!['quick', 'named', 'tailscale'].includes(mode)) {
      console.error('방식은 quick, named, tailscale 중 하나여야 합니다.');
      process.exit(1);
    }
    const next = { ...readConfig(), mode };
    // named 는 터널 이름과 주소를 함께 받아야 쓸 수 있다.
    for (const key of ['tunnel', 'hostname']) {
      const i = rest.indexOf(`--${key}`);
      if (i !== -1 && rest[i + 1]) next[key] = rest[i + 1];
    }
    if (mode !== 'named') {
      delete next.tunnel;
      delete next.hostname;
    }
    writeConfig(next);
    console.log(`공개 방식을 ${mode} 로 정했습니다.\n`);
    console.log(describe());
  } else {
    console.log(describe());
  }
}
