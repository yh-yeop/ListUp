/**
 * 실행 기록(텔레메트리) 저장소 — 창이 `window.listupDesktop.telemetry` 로 부른다. 계약은 shared 의 DesktopTelemetry.
 *
 * 파일은 앱 데이터 폴더(userData — 테스트는 LISTUP_DESKTOP_USER_DATA)에 TelemetryFileName 세 이름으로만 둔다.
 * 아무 데도 보내지 않는다. 실행 중 30초마다 오는 쓰기가 main 을 막지 않게 read·write·append·remove 는
 * fs/promises 로 하고, 같은 파일에 대한 작업은 줄을 세워(파일마다 promise 사슬) 차례로 한다.
 * 창이 닫히기 직전의 finishSync 만 동기다 — 창이 sendSync 로 기다리므로 그 사이에 끝내야 한다.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, shell, type BrowserWindow, type IpcMain } from 'electron';
import type { DesktopSystemInfo, TelemetryAppend, TelemetryFileName } from '@listup/shared';
import { IPC } from './protocol.ts';

const FILE_NAMES: readonly TelemetryFileName[] = ['telemetry.csv', 'telemetry-errors.csv', 'telemetry-pending.json'];
const CSV: TelemetryFileName = 'telemetry.csv';
const ERRORS: TelemetryFileName = 'telemetry-errors.csv';
const PENDING: TelemetryFileName = 'telemetry-pending.json';

/** 창에서 온 이름을 믿지 않는다 — 세 이름 말고는(경로·다른 파일) 거절한다. */
function assertName(name: unknown): TelemetryFileName {
  if (typeof name !== 'string' || !(FILE_NAMES as readonly string[]).includes(name)) {
    throw new Error(`실행 기록 파일 이름이 아닙니다: ${String(name)}`);
  }
  return name as TelemetryFileName;
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 은(는) 문자열이어야 합니다`);
  return value;
}

export function telemetryFolder(): string {
  return app.getPath('userData');
}

function fileOf(name: TelemetryFileName): string {
  return path.join(telemetryFolder(), name);
}

/** header 끝에 줄바꿈이 없으면 붙인다 — 없으면 첫 행이 머리줄 끝에 이어 붙는다. */
function headerLine(header: string): string {
  return header === '' || header.endsWith('\n') ? header : `${header}\n`;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

// ---------------------------------------------------------------------------
// 파일마다 줄 세우기
// ---------------------------------------------------------------------------

const queues = new Map<TelemetryFileName, Promise<unknown>>();
/**
 * finishSync 가 지울 때마다 1 씩 오른다. 그 전에 줄 선 비동기 write 가 finishSync 뒤에 돌아
 * telemetry-pending.json 을 되살리지 않게 — 줄 설 때의 값과 다르면 건너뛰고, 쓰는 사이에 바뀌었으면 다시 지운다.
 */
const epochs = new Map<TelemetryFileName, number>();
const epochOf = (name: TelemetryFileName) => epochs.get(name) ?? 0;

function enqueue<T>(name: TelemetryFileName, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve();
  const next = previous.then(job, job);
  // 실패는 부른 쪽에 돌려주고, 줄은 계속 이어지게 삼킨 것을 둔다.
  const tail = next.catch(() => {});
  queues.set(name, tail);
  void tail.then(() => {
    if (queues.get(name) === tail) queues.delete(name);
  });
  return next;
}

// ---------------------------------------------------------------------------
// 비동기 작업 (창의 invoke)
// ---------------------------------------------------------------------------

/**
 * atomic-write.ts 의 atomicWrite 와 같은 일을 비동기로 — 임시 파일에 쓰고 fsync 한 뒤 이름을 바꾼다.
 * Windows 에서 백신·동기화 프로그램이 대상을 붙들어 이름 바꾸기가 거부되면 제자리 쓰기로 물러난다.
 */
async function atomicWriteAsync(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      await fsp.writeFile(file, text);
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

export function readTelemetry(name: unknown): Promise<string | null> {
  const file = assertName(name);
  return enqueue(file, async () => {
    try {
      return await fsp.readFile(fileOf(file), 'utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  });
}

export function writeTelemetry(name: unknown, text: unknown): Promise<void> {
  const file = assertName(name);
  const body = assertText(text, 'text');
  const epoch = epochOf(file);
  return enqueue(file, async () => {
    if (epochOf(file) !== epoch) return;
    await atomicWriteAsync(fileOf(file), body);
    if (epochOf(file) !== epoch) await fsp.rm(fileOf(file), { force: true });
  });
}

export function appendTelemetry(name: unknown, text: unknown, header: unknown): Promise<void> {
  const file = assertName(name);
  const body = assertText(text, 'text');
  const head = headerLine(assertText(header, 'header'));
  return enqueue(file, async () => {
    const target = fileOf(file);
    let empty = false;
    try {
      empty = (await fsp.stat(target)).size === 0;
    } catch (err) {
      if (!isMissing(err)) throw err;
      empty = true;
      await fsp.mkdir(path.dirname(target), { recursive: true });
    }
    await fsp.appendFile(target, empty ? head + body : body);
  });
}

export function removeTelemetry(name: unknown): Promise<void> {
  const file = assertName(name);
  return enqueue(file, () => fsp.rm(fileOf(file), { force: true }));
}

// ---------------------------------------------------------------------------
// 동기 마무리 (창의 sendSync)
// ---------------------------------------------------------------------------

/**
 * 창이 닫히기 직전 — appends 를 차례로 붙이고(파일이 없거나 비어 있으면 header 먼저) telemetry-pending.json 을 지운다.
 * 동기라 줄 선 비동기 작업을 기다리지 않는다. 그 사이 끝나지 않은 append 와 겹쳐 머리줄이 두 번 들어갈 수는 있지만
 * (둘 다 빈 파일로 보았을 때) 줄 단위로 섞이지는 않는다 — 창은 마무리 전에 30초 타이머를 멈춘다.
 * 하나가 실패해도 나머지는 계속하고, 실패한 것들을 모아 던진다.
 */
export function finishTelemetrySync(appends: unknown): void {
  const errors: string[] = [];
  const list = Array.isArray(appends) ? (appends as unknown[]) : [];
  if (!Array.isArray(appends)) errors.push('appends 는 배열이어야 합니다');
  for (const entry of list) {
    try {
      const item = (entry ?? {}) as Partial<TelemetryAppend>;
      const file = assertName(item.name);
      const body = assertText(item.text, 'text');
      const head = headerLine(assertText(item.header, 'header'));
      const target = fileOf(file);
      let empty: boolean;
      try {
        empty = fs.statSync(target).size === 0;
      } catch (err) {
        if (!isMissing(err)) throw err;
        empty = true;
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
      fs.appendFileSync(target, empty ? head + body : body);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  try {
    epochs.set(PENDING, epochOf(PENDING) + 1);
    fs.rmSync(fileOf(PENDING), { force: true });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (errors.length > 0) throw new Error(errors.join(' / '));
}

// ---------------------------------------------------------------------------
// 사양·메모리
// ---------------------------------------------------------------------------

/**
 * OS 종류와 메이저 버전만 — 기기를 알아볼 만한 세부(빌드 번호 전체·배포판 이름)는 남기지 않는다.
 *   win32   os.release() 가 "10.0.<빌드>" — 빌드 22000 이상이면 Windows 11(둘 다 10.0 이라 빌드로만 갈린다), 아니면 10.
 *           그보다 옛것(6.x)은 "Windows <메이저>"
 *   darwin  Darwin 커널 버전 — 20(Big Sur) 부터는 macOS 메이저 = Darwin - 9, 19 는 macOS 10.15(Catalina)
 *   linux   커널 메이저 — "Linux 6"
 *   그 밖   os.type() 그대로
 * 순수 함수 — `platform`·`release`·`type` 은 process.platform·os.release()·os.type() 값.
 */
export function osLabel(platform: string, release: string, type: string): string {
  const parts = release.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0];
  if (platform === 'win32') {
    if (major === 10) return (parts[2] ?? 0) >= 22000 ? 'Windows 11' : 'Windows 10';
    return Number.isFinite(major) ? `Windows ${major}` : 'Windows';
  }
  if (platform === 'darwin') {
    if (!Number.isFinite(major)) return 'macOS';
    if (major >= 20) return `macOS ${major - 9}`;
    if (major >= 4) return `macOS 10.${major - 4}`;
    return 'macOS';
  }
  if (platform === 'linux') return Number.isFinite(major) ? `Linux ${major}` : 'Linux';
  return type;
}

export function systemInfo(): DesktopSystemInfo {
  return {
    cores: os.cpus().length,
    totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
    os: osLabel(process.platform, os.release(), os.type()),
  };
}

/**
 * 이 프로그램이 지금 쓰는 메모리(MB, 소수 한 자리) — app.getAppMetrics() 의 모든 Electron 프로세스
 * (main·창(renderer)·GPU·utility — 켜 둔 서버 프로세스도 utilityProcess 라 들어간다)의 working set 합.
 * workingSetSize 는 KB 단위다.
 */
export function memoryMb(): number {
  const kb = app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0);
  return Math.round((kb / 1024) * 10) / 10;
}

// ---------------------------------------------------------------------------
// 내보내기·폴더 열기
// ---------------------------------------------------------------------------

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * telemetry.csv 를 고른 곳에 복사하고, telemetry-errors.csv 가 있으면 그 옆에 `<고른 이름>-errors.csv` 로.
 * 기록이 없거나 취소하면 null, 저장했으면 csv 경로.
 */
export async function exportTelemetry(parent: BrowserWindow | null): Promise<string | null> {
  const source = fileOf(CSV);
  if (!fs.existsSync(source)) return null;
  // 시험 전용 — 저장 대화상자를 띄우지 않고 이 경로로 내보낸다(e2e·자동화).
  let target = process.env.LISTUP_TELEMETRY_EXPORT_PATH || null;
  if (!target) {
    const options: Electron.SaveDialogOptions = {
      title: '실행 기록 내보내기',
      defaultPath: path.join(app.getPath('downloads'), `telemetry-${today()}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    target = picked.filePath;
  }
  // 줄 선 append·write 가 끝난 뒤의 내용을 복사한다.
  await enqueue(CSV, () => fsp.mkdir(path.dirname(target), { recursive: true }).then(() => fsp.copyFile(source, target)));
  const errors = fileOf(ERRORS);
  if (fs.existsSync(errors)) {
    const base = path.basename(target, path.extname(target));
    const errorsTarget = path.join(path.dirname(target), `${base}-errors.csv`);
    await enqueue(ERRORS, () => fsp.copyFile(errors, errorsTarget));
  }
  return target;
}

export async function openTelemetryFolder(): Promise<void> {
  const dir = telemetryFolder();
  await fsp.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** main 의 registerIpc 에서 부른다. `getWindow` 는 저장 대화상자의 부모 창(없으면 null). */
export function registerTelemetryIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.telemetrySystem, () => systemInfo());
  ipcMain.handle(IPC.telemetryMemory, () => memoryMb());
  ipcMain.handle(IPC.telemetryRead, (_e, name: unknown) => readTelemetry(name));
  ipcMain.handle(IPC.telemetryWrite, (_e, name: unknown, text: unknown) => writeTelemetry(name, text));
  ipcMain.handle(IPC.telemetryAppend, (_e, name: unknown, text: unknown, header: unknown) => appendTelemetry(name, text, header));
  ipcMain.handle(IPC.telemetryRemove, (_e, name: unknown) => removeTelemetry(name));
  ipcMain.handle(IPC.telemetryFolder, () => telemetryFolder());
  ipcMain.handle(IPC.telemetryExport, () => exportTelemetry(getWindow()));
  ipcMain.handle(IPC.telemetryOpenFolder, () => openTelemetryFolder());
  // sendSync — returnValue 를 꼭 넣는다. 안 넣으면 창이 영영 기다린다. 실패는 창을 막지 않고 콘솔에만.
  ipcMain.on(IPC.telemetryFinish, (event, appends: unknown) => {
    try {
      finishTelemetrySync(appends);
      event.returnValue = true;
    } catch (err) {
      console.warn(`실행 기록을 마무리하지 못했습니다: ${err instanceof Error ? err.message : err}`);
      event.returnValue = false;
    }
  });
  // 디버그: 강제 종료 흉내 — before-quit·will-quit 없이, 정리 없이 바로 끝낸다(다음 실행에서 crashed=1).
  // 켜 둔 서버 프로세스(utilityProcess)도 함께 죽는다. 디버그 옵션이라 받아들인다.
  ipcMain.on(IPC.telemetryDebugCrash, () => {
    app.exit(1);
  });
}
