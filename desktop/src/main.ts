/**
 * ListUp PC 앱.
 *
 * 창에는 앱의 클라이언트 모드 웹 빌드를 `app://listup` 에 띄운다 — 주소가 늘 같아 서버 목록(localStorage)이
 * 남고, 보안 컨텍스트가 아니라 공유기 안의 http 서버에도 요청이 간다. 서버를 열면 서버는 utilityProcess
 * 에서 돌고(host.ts), 창을 닫아도 트레이에 남아 계속 돈다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  shell,
  Tray,
} from 'electron';
import type { HostSettingsPatch, HostStatus } from '@listup/shared';
import { allowRoot, readChunk, saveUrl, scanFolder } from './folders.ts';
import { credentialsAvailable, getCredential, removeCredential, setCredential } from './credentials.ts';
import { Host } from './host.ts';
import { IPC } from './protocol.ts';
import { readSettings, writeSettings } from './settings.ts';
import { inspectTools } from './tunnel.ts';

const ORIGIN = 'app://listup';

// 테스트가 설정·로그인 정보·서버 데이터를 임시 폴더에 두게 한다.
if (process.env.LISTUP_DESKTOP_USER_DATA) app.setPath('userData', process.env.LISTUP_DESKTOP_USER_DATA);

/**
 * 파일 위치. 창에 띄우는 것은 main 과 함께(개발은 `.build`, 설치본은 app.asar 안), 서버가 쓰는 것은
 * 개발은 `.build`, 설치본은 resources 폴더(asar 밖 — 서버 프로세스가 네이티브 모듈과 함께 읽는다).
 *   web-client   창에 띄우는 웹 (클라이언트 모드)
 *   web-server   서버가 함께 서빙하는 웹 (서버 모드)
 *   server/      묶은 서버와 그 의존성
 */
const RESOURCES = app.isPackaged ? process.resourcesPath : __dirname;
const paths = {
  webClient: path.join(__dirname, 'web-client'),
  preload: path.join(__dirname, 'preload.cjs'),
  webServer: path.join(RESOURCES, 'web-server'),
  serverEntry: path.join(RESOURCES, 'server', 'server.mjs'),
  icon: path.join(RESOURCES, 'icon.png'),
};

protocol.registerSchemesAsPrivileged([
  // secure: false — https 페이지는 http 서버(공유기 안)에 요청하지 못한다.
  { scheme: 'app', privileges: { standard: true, secure: false, supportFetchAPI: true, corsEnabled: true } },
]);

// 같은 앱을 두 번 켜면 서버가 둘이 된다 — 이미 켜진 창을 앞으로.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const host = new Host({ serverEntry: paths.serverEntry, serverWeb: paths.webServer });
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/** `listup://join?server=…&code=…` 을 앱 안 주소로. 다른 모양이면 null. */
function appUrlFromDeepLink(argv: string[]): string | null {
  const link = argv.find((arg) => arg.startsWith('listup://'));
  if (!link) return null;
  try {
    const url = new URL(link);
    const route = (url.host + url.pathname).replace(/^\/+|\/+$/g, '');
    return route === 'join' ? `${ORIGIN}/join${url.search}` : null;
  } catch {
    return null;
  }
}

/** 웹 빌드를 app:// 로 서빙한다. 파일이 없으면 SPA 라 index.html. */
function serveWebClient(): void {
  const root = paths.webClient;
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = path.join(root, relative);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function isDownloadLink(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/api/dl');
  } catch {
    return false;
  }
}

function createWindow(initialUrl: string | null): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 380,
    minHeight: 500,
    show: false,
    title: 'ListUp',
    icon: paths.icon,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);

  // 링크는 브라우저로. 앱 창은 app:// 밖으로 나가지 않는다.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isDownloadLink(url)) window.webContents.downloadURL(url);
    else if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    event.preventDefault();
    // 내려받기는 짧게 사는 링크로 온다 — 저장 위치를 물어 받는다.
    if (isDownloadLink(url)) window.webContents.downloadURL(url);
    else if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  window.on('close', (event) => {
    if (quitting || !host.running) return;
    // 서버가 돌고 있으면 창만 숨긴다 — 들어와 있는 사람들이 끊기지 않게.
    event.preventDefault();
    window.hide();
    const settings = readSettings();
    if (!settings.trayNoticeShown && Notification.isSupported()) {
      new Notification({
        title: 'ListUp 서버는 계속 실행 중입니다',
        body: '작업 표시줄 오른쪽 트레이의 ListUp 아이콘에서 열거나 끝낼 수 있습니다.',
        icon: paths.icon,
      }).show();
      writeSettings({ trayNoticeShown: true });
    }
  });
  window.on('closed', () => {
    if (win === window) win = null;
  });
  window.once('ready-to-show', () => window.show());
  void window.loadURL(initialUrl ?? `${ORIGIN}/`);
  return window;
}

function showWindow(url: string | null = null): void {
  if (!win) {
    win = createWindow(url);
    return;
  }
  if (url) void win.loadURL(url);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await host.stop();
  app.quit();
}

function trayMenu(status: HostStatus): Menu {
  const label: Record<HostStatus['state'], string> = {
    stopped: '서버 꺼짐',
    starting: '서버 켜는 중…',
    running: `서버 실행 중 — ${status.tunnel.url ?? status.localUrl}`,
    stopping: '서버 끄는 중…',
    error: '서버 오류',
  };
  return Menu.buildFromTemplate([
    { label: 'ListUp 열기', click: () => showWindow() },
    { type: 'separator' },
    { label: label[status.state], enabled: false },
    status.state === 'running' || status.state === 'starting'
      ? { label: '서버 끄기', click: () => void host.stop() }
      : { label: '서버 켜기', click: () => void host.start(), enabled: status.state !== 'stopping' },
    { type: 'separator' },
    { label: '끝내기', click: () => void quit() },
  ]);
}

function createTray(): void {
  const image = nativeImage.createFromPath(paths.icon).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('ListUp');
  tray.setContextMenu(trayMenu(host.status()));
  tray.on('click', () => showWindow());
}

function pickFolder(options: { title: string; defaultPath?: string }) {
  const props: Electron.OpenDialogOptions = { ...options, properties: ['openDirectory', 'createDirectory'] };
  return win ? dialog.showOpenDialog(win, props) : dialog.showOpenDialog(props);
}

function registerIpc(): void {
  ipcMain.handle(IPC.credentialsGet, (_e, key: string) => getCredential(key));
  ipcMain.handle(IPC.credentialsSet, (_e, key: string, value: string) => setCredential(key, value));
  ipcMain.handle(IPC.credentialsRemove, (_e, key: string) => removeCredential(key));

  ipcMain.handle(IPC.hostStatus, () => host.status());
  ipcMain.handle(IPC.hostStart, () => host.start());
  ipcMain.handle(IPC.hostStop, () => host.stop());
  ipcMain.handle(IPC.hostUpdate, (_e, patch: HostSettingsPatch) => {
    if (patch.openAtLogin !== undefined && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, args: ['--hidden'] });
    }
    return host.update(patch);
  });
  ipcMain.handle(IPC.hostTools, () => inspectTools());
  ipcMain.handle(IPC.hostResetCode, (_e, email: string) => host.issueResetCode(email));
  ipcMain.handle(IPC.hostBackup, async () => {
    const picked = await pickFolder({ title: '백업을 담을 폴더' });
    if (picked.canceled || !picked.filePaths[0]) return null;
    await host.backup(picked.filePaths[0]);
    return picked.filePaths[0];
  });
  ipcMain.handle(IPC.hostChooseData, async () => {
    const picked = await pickFolder({ title: '서버 데이터 폴더', defaultPath: host.status().dataDir });
    if (picked.canceled || !picked.filePaths[0]) return host.status();
    return host.setDataDir(picked.filePaths[0]);
  });
  ipcMain.handle(IPC.hostOpenData, async () => {
    const dir = host.status().dataDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
  ipcMain.handle(IPC.hostLogs, () => host.logs());

  ipcMain.handle(IPC.foldersPick, async () => {
    const picked = await pickFolder({ title: '저장소와 견줄 내 폴더' });
    const root = picked.canceled ? undefined : picked.filePaths[0];
    if (!root) return null;
    allowRoot(root);
    return { root, name: path.basename(root) || root };
  });
  ipcMain.handle(IPC.foldersScan, (_e, root: string) => scanFolder(root));
  ipcMain.handle(IPC.foldersRead, (_e, root: string, relativePath: string, offset: number, length: number) =>
    readChunk(root, relativePath, offset, length),
  );
  ipcMain.handle(IPC.foldersSave, (_e, root: string, relativePath: string, url: string) => saveUrl(root, relativePath, url));
}

app.on('second-instance', (_event, argv) => showWindow(appUrlFromDeepLink(argv)));

app.on('window-all-closed', () => {
  // 서버가 돌고 있으면 트레이에 남는다.
  if (!host.running) void quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void quit();
});

void app.whenReady().then(() => {
  // 테스트(임시 데이터 폴더)로 띄운 설치본은 OS 에 listup:// 을 등록하지 않는다 — 지워질 실행 파일을 가리키게 된다.
  if (app.isPackaged && !process.env.LISTUP_DESKTOP_USER_DATA) app.setAsDefaultProtocolClient('listup');
  if (!credentialsAvailable()) console.warn('safeStorage 를 쓸 수 없습니다 — 로그인 정보 저장이 동작하지 않습니다.');
  serveWebClient();
  registerIpc();
  createTray();
  host.on('change', (status: HostStatus) => {
    tray?.setContextMenu(trayMenu(status));
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.hostChanged, status);
  });

  const settings = readSettings();
  const hidden = process.argv.includes('--hidden');
  if (settings.autoStart || hidden) void host.start();
  if (!hidden) showWindow(appUrlFromDeepLink(process.argv));
});
