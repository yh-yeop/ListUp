/**
 * 배포용 묶음을 만든다.
 *
 *   npm run release        →  release/listup-<버전>.zip (Windows) / .tar.gz (그 외)
 *
 * 받는 사람이 겪을 일을 줄이는 것이 목적이다. 소스에서 시작하면 저장소를 clone 하고
 * 앱(Expo) 의존성 수백 MB 를 받은 뒤 웹을 직접 빌드해야 하는데, 그 과정이 이 도구를
 * 써보려는 사람에게는 과하다.
 *
 * 그래서 **웹을 미리 빌드해 넣고 앱 워크스페이스는 통째로 뺀다.** 받는 사람은 압축을 풀고
 * `npm install` 로 서버 의존성만 받으면 된다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNpm } from './run-npm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'release');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = rootPkg.version;
const STAGE = path.join(OUT_DIR, `listup-${VERSION}`);

const say = (m) => console.log(m);

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, { stdio: 'inherit', cwd: ROOT, ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm 실패 (${code})`))));
  });
}

function copy(from, to, filter) {
  fs.cpSync(path.join(ROOT, from), path.join(STAGE, to ?? from), { recursive: true, filter });
}

// ---------------------------------------------------------------------------
// 1. 웹을 새로 빌드한다 — 묶음에 들어갈 것이므로 최신인지 확실히 해둔다.
// ---------------------------------------------------------------------------
say(`ListUp ${VERSION} 배포 묶음을 만듭니다.\n`);
say('웹을 빌드합니다…');
await runNpm(['run', 'build:web', '--workspace', '@listup/app', '--', '--clear'], {
  env: { ...process.env, EXPO_PUBLIC_LISTUP_API_URL: '/' },
});
fs.writeFileSync(path.join(ROOT, 'app', 'dist', '.listup-api-url'), '/\n');

// ---------------------------------------------------------------------------
// 2. 담는다.
// ---------------------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

say('파일을 담는 중…');
// 서버·공용 코드는 tsx 가 TypeScript 를 그대로 돌리므로 소스 그대로 넣는다.
copy('server/src', 'server/src');
copy('server/package.json', 'server/package.json');
copy('server/tsconfig.json', 'server/tsconfig.json');
copy('shared', 'shared', (src) => !src.includes('node_modules'));
copy('app/dist', 'app/dist');
copy('README.md', 'README.md');
copy('LICENSE', 'LICENSE');
copy('docs', 'docs');

// 실행에 필요한 스크립트만. release.mjs 는 만드는 쪽 도구라 뺀다.
fs.mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
for (const name of ['serve.mjs', 'tunnel.mjs', 'run-npm.mjs', 'sync-folder.mjs']) {
  copy(`scripts/${name}`, `scripts/${name}`);
}

// 앱 워크스페이스를 뺐으므로 루트 package.json 을 그에 맞게 다시 쓴다.
const releasePkg = {
  name: rootPkg.name,
  version: VERSION,
  private: true,
  description: rootPkg.description,
  workspaces: ['shared', 'server'],
  scripts: {
    serve: 'node scripts/serve.mjs',
    tunnel: 'node scripts/tunnel.mjs',
    sync: 'node scripts/sync-folder.mjs',
    backup: 'npm run backup --workspace @listup/server --',
    gc: 'npm run gc --workspace @listup/server --',
  },
  license: rootPkg.license,
  dependencies: { 'qrcode-terminal': rootPkg.dependencies['qrcode-terminal'] },
  engines: rootPkg.engines,
  // 네이티브 모듈이 프리빌드를 받아야 하므로 설치 스크립트를 미리 허용해 둔다.
  allowScripts: rootPkg.allowScripts,
};
fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`);

// 받는 사람이 가장 먼저 볼 것.
fs.writeFileSync(
  path.join(STAGE, '시작하기.txt'),
  [
    `ListUp ${VERSION}`,
    '',
    '1. Node 20.11 이상이 필요합니다.  https://nodejs.org',
    '',
    '2. 이 폴더에서 한 번만:',
    '     npm install',
    '',
    '3. 켜기:',
    '     npm run serve                (이 PC 에서만)',
    '     npm run serve -- --tunnel    (밖에서도 접속 + QR 코드)',
    '',
    '   --tunnel 은 cloudflared 가 필요합니다.',
    '     Windows  winget install Cloudflare.cloudflared',
    '     macOS    brew install cloudflared',
    '',
    '4. 브라우저가 열리면 회원가입부터 하세요. 그 계정이 이 서버의 첫 사용자입니다.',
    '',
    'Copyright (C) 2026 yh-yeop',
    '이 프로그램은 AGPL-3.0 입니다. 자세한 것은 LICENSE 파일을 보세요.',
    '고쳐서 남에게 서비스하거나 배포하려면 소스를 함께 공개해야 합니다.',
    '',
    '자세한 내용은 README.md 를 보세요.',
    '내 파일은 server/data 에 쌓입니다 — 이 폴더를 지우면 전부 사라집니다.',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------------------
// 3. 압축한다.
// ---------------------------------------------------------------------------
say('압축하는 중…');
const isWin = process.platform === 'win32';
const archive = path.join(OUT_DIR, `listup-${VERSION}.${isWin ? 'zip' : 'tar.gz'}`);
fs.rmSync(archive, { force: true });

if (isWin) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path "${STAGE}" -DestinationPath "${archive}" -Force`],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('tar', ['-czf', archive, '-C', OUT_DIR, `listup-${VERSION}`], { stdio: 'inherit' });
}

const size = fs.statSync(archive).size;
say('');
say(`${archive}`);
say(`  ${(size / 1024 / 1024).toFixed(1)}MB`);
say('');
say('받는 사람은 압축을 풀고 `npm install` → `npm run serve` 만 하면 됩니다.');
say('(앱 워크스페이스를 뺐으므로 Expo 의존성을 받지 않습니다)');
