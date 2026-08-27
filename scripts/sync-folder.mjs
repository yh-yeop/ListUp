/**
 * 로컬 폴더를 ListUp 저장소에 맞춘다. 폴더 구조를 그대로 살려 올린다.
 *
 *   node scripts/sync-folder.mjs <폴더> --repo <저장소ID> [옵션]
 *
 * 옵션
 *   --server <URL>    서버 주소 (기본 http://localhost:4000)
 *   --repo <id>       올릴 저장소. --repo-name 으로 이름을 줘도 된다(없으면 만든다)
 *   --repo-name <이름>
 *   --ext mp3,lrc     이 확장자만 (기본: 전부)
 *   --dry-run         무엇을 할지만 보여주고 아무것도 바꾸지 않는다
 *
 * 로그인은 환경변수로 준다.
 *   LISTUP_EMAIL / LISTUP_PASSWORD   또는   LISTUP_TOKEN
 *
 * **다시 돌려도 된다.** 서버에 있는 파일과 해시를 견주어 새 파일과 바뀐 파일만 올린다.
 * 서버에만 있는 파일은 건드리지 않는다 (지우려면 앱에서 직접).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const has = (name) => argv.includes(`--${name}`);

/** 플래그와 그 값을 뺀 나머지 중 첫 번째가 폴더다. */
const VALUE_FLAGS = new Set(['--server', '--repo', '--repo-name', '--ext']);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (VALUE_FLAGS.has(argv[i])) {
    i += 1; // 이 플래그의 값은 건너뛴다
    continue;
  }
  if (argv[i].startsWith('--')) continue;
  positional.push(argv[i]);
}
const root = positional[0] ? path.resolve(positional[0]) : null;
const server = (flag('server') ?? 'http://localhost:4000').replace(/\/+$/, '');
const repoId = flag('repo');
const repoName = flag('repo-name');
const extFilter = flag('ext')
  ? new Set(
      flag('ext')
        .split(',')
        .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean),
    )
  : null;
const dryRun = has('dry-run');

if (!root || !fs.existsSync(root)) {
  console.error('폴더를 지정해 주세요. 예: node scripts/sync-folder.mjs "C:\\\\Users\\\\나\\\\Music" --repo repo_xxx');
  process.exit(1);
}
if (!repoId && !repoName) {
  console.error('--repo <저장소ID> 또는 --repo-name <이름> 중 하나가 필요합니다.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
let token = process.env.LISTUP_TOKEN ?? null;

async function api(pathname, options = {}) {
  const res = await fetch(`${server}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // JSON 이 아닌 응답 (프록시 오류 등)
  }
  if (!res.ok) {
    const message = json?.error?.message ?? `${res.status} ${text.slice(0, 120)}`;
    throw new Error(message);
  }
  return json;
}

async function login() {
  if (token) return;
  const email = process.env.LISTUP_EMAIL;
  const password = process.env.LISTUP_PASSWORD;
  if (!email || !password) {
    console.error('LISTUP_EMAIL 과 LISTUP_PASSWORD 환경변수를 지정하거나 LISTUP_TOKEN 을 주세요.');
    process.exit(1);
  }
  const result = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  token = result.token;
}

/** 저장소의 모든 파일을 경로 → 해시 로 모은다. 폴더를 재귀로 훑는다. */
async function serverManifest(id) {
  const manifest = new Map();
  const walk = async (dir) => {
    const query = dir ? `?path=${encodeURIComponent(dir)}` : '';
    const { tree } = await api(`/api/repos/${id}/files${query}`);
    for (const file of tree.files) manifest.set(file.path, file.blobHash);
    for (const sub of tree.dirs) await walk(sub.path);
  };
  await walk('');
  return manifest;
}

// ---------------------------------------------------------------------------
// 로컬
// ---------------------------------------------------------------------------
function localFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...localFiles(full, base));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (extFilter && !extFilter.has(ext)) continue;
    out.push({
      full,
      // 저장소 경로는 항상 `/` 를 쓰고, 유니코드는 NFC 로 맞춘다.
      // 서버가 경로를 NFC 로 정규화하므로, 여기서 맞춰 두지 않으면 파일 이름에
      // 분해형 글자(예: NFD 로 저장된 "ROSÉ")가 있을 때 매번 다른 파일로 보고 다시 올린다.
      rel: path.relative(base, full).split(path.sep).join('/').normalize('NFC'),
      size: fs.statSync(full).size,
    });
  }
  return out;
}

/** 파일을 통째로 메모리에 올리지 않고 해시한다. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
await login();

let targetRepo = repoId;
if (!targetRepo) {
  const { repos } = await api('/api/repos');
  const found = repos.find((r) => r.name === repoName);
  if (found) {
    targetRepo = found.id;
    console.log(`저장소 "${repoName}" 를 찾았습니다 (${targetRepo}).`);
  } else {
    const created = await api('/api/repos', { method: 'POST', body: { name: repoName } });
    targetRepo = created.repo.id;
    console.log(`저장소 "${repoName}" 를 만들었습니다 (${targetRepo}).`);
  }
}

console.log(`\n로컬 폴더를 훑는 중… ${root}`);
const files = localFiles(root);
const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
console.log(`  대상 ${files.length}개 · ${mb(totalBytes)}`);

console.log('서버 목록을 받는 중…');
const remote = await serverManifest(targetRepo);
console.log(`  서버에 ${remote.size}개`);

console.log('견주는 중… (해시 계산)');
const todo = [];
let same = 0;
for (const file of files) {
  const hash = await sha256(file.full);
  const remoteHash = remote.get(file.rel);
  if (remoteHash === hash) {
    same += 1;
    continue;
  }
  todo.push({ ...file, kind: remoteHash ? '수정' : '추가' });
}

const todoBytes = todo.reduce((sum, f) => sum + f.size, 0);
const onlyRemote = [...remote.keys()].filter((p) => !files.some((f) => f.rel === p));

console.log('');
console.log(`  그대로   ${same}개`);
console.log(`  올릴 것  ${todo.length}개 · ${mb(todoBytes)}`);
if (onlyRemote.length > 0) {
  console.log(`  서버에만 ${onlyRemote.length}개 (건드리지 않습니다)`);
}

if (todo.length === 0) {
  console.log('\n올릴 것이 없습니다.');
  process.exit(0);
}
if (dryRun) {
  console.log('\n--dry-run 이라 여기서 멈춥니다.');
  for (const f of todo.slice(0, 20)) console.log(`  ${f.kind}  ${f.rel}`);
  if (todo.length > 20) console.log(`  … 외 ${todo.length - 20}개`);
  process.exit(0);
}

console.log('');
let done = 0;
let sent = 0;
let failed = 0;
const started = Date.now();

for (const file of todo) {
  const form = new FormData();
  const bytes = await fsp.readFile(file.full);
  form.append('file', new Blob([bytes]), path.basename(file.rel));
  try {
    await api(`/api/repos/${targetRepo}/files?path=${encodeURIComponent(file.rel)}`, {
      method: 'POST',
      body: form,
    });
    done += 1;
    sent += file.size;
  } catch (err) {
    failed += 1;
    console.log(`  실패  ${file.rel} — ${err.message}`);
    // 용량 한도처럼 계속해도 소용없는 오류면 멈춘다.
    if (/한도|too large|payload/i.test(err.message)) {
      console.log('\n용량 한도에 걸렸습니다. LISTUP_MAX_REPO_MB 를 올리고 다시 돌려 주세요.');
      break;
    }
  }
  const at = done + failed;
  const pct = Math.round((at / todo.length) * 100);
  const speed = sent / Math.max(1, (Date.now() - started) / 1000);
  const line = `${pct}%  ${at}/${todo.length}  ${mb(sent)} 전송  ${mb(speed)}/s`;
  if (process.stdout.isTTY) {
    // 터미널에서는 한 줄을 덮어쓴다.
    process.stdout.write(`\r  ${line}   `);
  } else if (at === todo.length || at % 50 === 0) {
    // 로그로 남길 때는 줄이 쌓이지 않게 가끔만.
    console.log(`  ${line}`);
  }
}

console.log('\n');
console.log(`올림 ${done}개 · ${mb(sent)}${failed > 0 ? ` · 실패 ${failed}개` : ''}`);
console.log(`걸린 시간 ${Math.round((Date.now() - started) / 1000)}초`);
if (failed > 0) console.log('실패한 것은 다시 돌리면 이어서 올라갑니다.');
