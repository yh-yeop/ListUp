/**
 * PC 앱 (Electron) — 띄우기와 설치 파일 만들기.
 *
 *   npm run desktop                   묶어서 띄운다 (웹 빌드는 없을 때만 만든다)
 *   npm run desktop -- --web          웹을 새로 빌드하고 띄운다 (앱 화면을 고쳤을 때)
 *   npm run desktop -- --no-launch    묶기만 (테스트가 Electron 을 직접 띄울 때)
 *   npm run build:desktop             설치 파일 → release/listup-<버전>-windows-setup.exe
 *   npm run build:desktop -- --no-web 설치 파일을 지난 웹 빌드로 (설치 파일 구성만 고쳤을 때)
 *
 * 묶는 것 (desktop/.build):
 *   main.cjs · preload.cjs   Electron 본체와 창 연결부 (esbuild)
 *   server/server.mjs        서버 — 우리 코드만 묶고 npm 의존성(fastify·better-sqlite3 …)은 밖에 둔다
 *   web-client/              창에 띄우는 웹 (클라이언트 모드)
 *   web-server/              서버가 함께 서빙하는 웹 (서버 모드 — 브라우저로 들어오는 사람용)
 *   icon.png
 *
 * 설치 파일은 임시 폴더(listup-desktop-stage)에 앱(.build 의 창 쪽)과 서버(server.mjs + 운영 의존성)를 따로 담아
 * electron-builder(NSIS)로 만든다. 서버 의존성은 앱 안(asar)이 아니라 resources 폴더에 들어간다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { spawnNpm } from './run-npm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const OUT = path.join(DESKTOP, '.build');
const RELEASE = path.join(ROOT, 'release');
/**
 * 설치 파일 재료를 모으는 곳. 저장소 밖에 둔다 — 안에 두면 electron-builder 가 저장소를 워크스페이스로 알아보고
 * 루트 node_modules(Expo 등 수백 MB)를 앱에 담으려 한다.
 */
const STAGE = path.join(os.tmpdir(), 'listup-desktop-stage');

const argv = process.argv.slice(2);
const dist = argv.includes('--dist');
// 설치 파일은 늘 새 웹으로 — 설치 파일 쪽만 고치며 다시 만들 때는 --no-web 으로 지난 웹 빌드를 쓴다.
const rebuildWeb = (dist && !argv.includes('--no-web')) || argv.includes('--web');

const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;
const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8'));
/**
 * 서버를 돌리는 데 필요한 npm 의존성 — 우리 워크스페이스(shared)와 tsx(묶었으니 필요 없음)는 뺀다.
 * 버전은 지금 저장소에 설치돼 테스트를 통과한 그 버전으로 고정한다.
 */
const serverDeps = Object.fromEntries(
  Object.keys(serverPkg.dependencies)
    .filter((name) => !name.startsWith('@listup/') && name !== 'tsx')
    .map((name) => [name, JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version]),
);

const say = (m) => console.log(m);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 실패 (${code})`))));
  });
}

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args[0]} 실패 (${code})`))));
  });
}

// ---------------------------------------------------------------------------
// 1. 코드 묶기
// ---------------------------------------------------------------------------
say('PC 앱 코드를 묶습니다…');
fs.mkdirSync(OUT, { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
  sourcemap: dist ? false : 'inline',
  define: { 'process.env.LISTUP_DESKTOP_VERSION': JSON.stringify(version) },
};
await build({
  ...common,
  entryPoints: { main: path.join(DESKTOP, 'src', 'main.ts'), preload: path.join(DESKTOP, 'src', 'preload.ts') },
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: [path.join(DESKTOP, 'src', 'server-entry.ts')],
  outfile: path.join(OUT, 'server', 'server.mjs'),
  format: 'esm',
  external: Object.keys(serverDeps),
});
fs.copyFileSync(path.join(ROOT, 'app', 'assets', 'icon.png'), path.join(OUT, 'icon.png'));

// ---------------------------------------------------------------------------
// 2. 웹 빌드 — 창에 띄울 클라이언트 모드, 서버가 서빙할 서버 모드
// ---------------------------------------------------------------------------
async function buildWeb(mode) {
  const outDir = path.join(OUT, `web-${mode}`);
  if (!rebuildWeb && fs.existsSync(path.join(outDir, 'index.html'))) return;
  say(`웹을 빌드합니다 (${mode === 'client' ? '창' : '서버'}용, 몇 분 걸립니다)…`);
  const env = { ...process.env, CI: '1' };
  delete env.EXPO_PUBLIC_LISTUP_API_URL;
  delete env.EXPO_PUBLIC_LISTUP_CLIENT;
  if (mode === 'server') env.EXPO_PUBLIC_LISTUP_API_URL = '/';
  else env.EXPO_PUBLIC_LISTUP_CLIENT = '1';
  fs.rmSync(outDir, { recursive: true, force: true });
  const expoCli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
  await run(process.execPath, [expoCli, 'export', '--platform', 'web', '--clear', '--output-dir', outDir], {
    cwd: path.join(ROOT, 'app'),
    env,
  });
}
await buildWeb('client');
await buildWeb('server');

// Electron 실행 파일 — npm 이 설치 스크립트를 막아 두면 받아지지 않는다.
const electronDir = path.join(ROOT, 'node_modules', 'electron');
if (!fs.existsSync(path.join(electronDir, 'path.txt'))) {
  say('Electron 실행 파일을 받습니다…');
  await run(process.execPath, [path.join(electronDir, 'install.js')]);
}

// ---------------------------------------------------------------------------
// 3a. 띄우기
// ---------------------------------------------------------------------------
if (argv.includes('--no-launch')) {
  say('묶었습니다: desktop/.build');
} else if (!dist) {
  const electron = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
  const env = { ...process.env };
  // VS Code 같은 Electron 기반 터미널이 넣어 두면 Electron 이 창 없이 Node 로 돈다.
  delete env.ELECTRON_RUN_AS_NODE;
  say('PC 앱을 띄웁니다. 끝내려면 트레이의 ListUp → 끝내기 (또는 Ctrl+C).');
  const child = spawn(electron, [DESKTOP, ...argv.filter((a) => !a.startsWith('--'))], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill());
} else {
  // -------------------------------------------------------------------------
  // 3b. 설치 파일
  // -------------------------------------------------------------------------
  say('\n설치 파일에 담을 것을 모읍니다…');
  fs.rmSync(STAGE, { recursive: true, force: true });

  // 앱: 창 쪽만. 의존성은 전부 묶였다.
  const appDir = path.join(STAGE, 'app');
  fs.mkdirSync(path.join(appDir, '.build'), { recursive: true });
  for (const name of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(OUT, name), path.join(appDir, '.build', name));
  fs.cpSync(path.join(OUT, 'web-client'), path.join(appDir, '.build', 'web-client'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'listup',
        productName: 'ListUp',
        version,
        description: 'ListUp — 초대 코드로 참여하는 파일 공유',
        author: 'yh-yeop',
        license: 'AGPL-3.0-only',
        main: '.build/main.cjs',
      },
      null,
      2,
    )}\n`,
  );

  // 서버: 묶은 파일 + 운영 의존성. 저장소 워크스페이스 밖이라 npm 이 따로 설치한다.
  const serverDir = path.join(STAGE, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.copyFileSync(path.join(OUT, 'server', 'server.mjs'), path.join(serverDir, 'server.mjs'));
  fs.writeFileSync(
    path.join(serverDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'listup-server-runtime',
        private: true,
        type: 'module',
        dependencies: serverDeps,
        // better-sqlite3 는 N-API 바이너리가 들어 있다 — node-gyp 로 다시 빌드하지 않는다.
        allowScripts: { 'better-sqlite3': false },
      },
      null,
      2,
    )}\n`,
  );
  await runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: serverDir });
  // better-sqlite3 는 모든 OS 의 바이너리와 SQLite 소스를 담고 온다 — Windows x64 것만 남긴다.
  const sqlite = path.join(serverDir, 'node_modules', 'better-sqlite3');
  for (const name of ['deps', 'src', 'build']) fs.rmSync(path.join(sqlite, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(path.join(sqlite, 'prebuilds'))) {
    if (name !== 'win32-x64.node') fs.rmSync(path.join(sqlite, 'prebuilds', name), { force: true });
  }

  fs.cpSync(path.join(OUT, 'web-server'), path.join(STAGE, 'web-server'), { recursive: true });
  fs.copyFileSync(path.join(OUT, 'icon.png'), path.join(STAGE, 'icon.png'));

  const electronVersion = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
  const outDir = path.join(STAGE, 'out');
  /** @type {Record<string, unknown>} */
  const config = {
    appId: 'io.github.yh-yeop.listup',
    productName: 'ListUp',
    electronVersion,
    npmRebuild: false,
    directories: { app: appDir, output: outDir },
    files: ['.build/**', 'package.json'],
    extraResources: [
      { from: serverDir, to: 'server' },
      { from: path.join(STAGE, 'web-server'), to: 'web-server' },
      { from: path.join(STAGE, 'icon.png'), to: 'icon.png' },
    ],
    protocols: [{ name: 'ListUp', schemes: ['listup'] }],
    win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(STAGE, 'icon.png') },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      artifactName: `listup-${version}-windows-setup.\${ext}`,
      shortcutName: 'ListUp',
    },
    publish: null,
  };
  // electron-builder 는 extraResources 에서도 node_modules 를 거른다 — 패키징 직후(설치 파일로 묶기 전)에 직접 넣는다.
  const afterPack = path.join(STAGE, 'after-pack.cjs');
  fs.writeFileSync(
    afterPack,
    `const fs = require('node:fs');
const path = require('node:path');
` +
      `exports.default = async (context) => {
` +
      `  fs.cpSync(${JSON.stringify(path.join(serverDir, 'node_modules'))}, path.join(context.appOutDir, 'resources', 'server', 'node_modules'), { recursive: true });
` +
      `};
`,
  );
  config.afterPack = afterPack;
  const configFile = path.join(STAGE, 'electron-builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  say('설치 파일을 만듭니다 (electron-builder)…');
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await run(process.execPath, [builderCli, '--win', '--x64', '--config', configFile, '--projectDir', appDir], {
    cwd: STAGE,
    env,
  });

  const setupName = `listup-${version}-windows-setup.exe`;
  fs.mkdirSync(RELEASE, { recursive: true });
  fs.copyFileSync(path.join(outDir, setupName), path.join(RELEASE, setupName));
  const size = (fs.statSync(path.join(RELEASE, setupName)).size / 1024 / 1024).toFixed(1);
  say(`\n완료: release/${setupName} (${size}MB)`);
}
