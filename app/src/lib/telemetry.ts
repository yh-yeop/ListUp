import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type { TelemetryAppend, TelemetryFileName } from '@listup/shared';
import { desktopBridge } from './desktop';
import {
  RunStats,
  TELEMETRY_ERRORS_HEADER,
  TELEMETRY_HEADER,
  androidOs,
  browserOs,
  classifyDevice,
  countCsvRows,
  errorTypeOf,
  errorTypesToCsv,
  iosOs,
  isMobileUserAgent,
  isUuid,
  localDate,
  makePending,
  parseCpuRange,
  parseMemTotalMb,
  parseProcStatusRssMb,
  randomUuid,
  recoverPending,
  rowToCsv,
  type TelemetryMeta,
} from './pure/telemetry';

export { TELEMETRY_ITEMS, TELEMETRY_NOT_RECORDED } from './pure/telemetry';

/**
 * 실행 기록(텔레메트리) — 학교 데이터 분석 과제용. 동의한 기기에서만, 실행 1회를 telemetry.csv 1행으로 남긴다.
 * 네트워크로는 아무것도 보내지 않는다. 사용자가 「실행 기록」 화면의 내보내기로 직접 꺼내 전달한다.
 *
 *   측정   1초마다: 그 1초의 fps(requestAnimationFrame 으로 센 프레임), 메모리 한 번, 화면에 보이던 시간
 *   저장   30초마다 지금 값을 telemetry-pending.json 에 덮어쓴다. 정상 종료(웹·PC 창 닫힘)면 CSV 에 한 행을
 *          붙이고 임시 파일을 지운다. 다음 실행에서 임시 파일이 남아 있으면 그 행을 crashed=1 로 옮긴다
 *          (백그라운드로 내려간 뒤 OS 가 치운 것은 정상 — pure/telemetry.ts recoverPending)
 *   에러   처리되지 않은 예외(전역 핸들러) + 잡힌 예외(recordCaughtError — API 요청 실패, 화면 로딩 실패) +
 *          에러 레벨 로그(console.error). 종류 이름별 개수는 telemetry-errors.csv 에 따로
 *
 * 저장소는 실행 환경마다 다르다 (모두 앱 데이터 폴더):
 *   PC 앱      main 프로세스가 userData 폴더에 비동기로 쓴다(window.listupDesktop.telemetry). 메모리는 모든 Electron 프로세스 합
 *   안드로이드  앱 전용 문서 폴더(documentDirectory/telemetry/). 메모리는 /proc/self/status 의 VmRSS
 *   브라우저   이 사이트의 localStorage. 메모리는 performance.memory 의 JS 힙(Chrome 계열만, 근사치)
 */

export type TelemetryConsent = 'unset' | 'granted' | 'denied';

const CONSENT_KEY = 'listup.telemetry.consent';
const DEVICE_KEY = 'listup.telemetry.deviceId';
const WEB_FILE_PREFIX = 'listup.telemetry.file.';
const SAMPLE_MS = 1_000;
const SAVE_EVERY_MS = 30_000;
/** 에러가 나면 30초를 기다리지 않고 이만큼 뒤에 임시 기록을 쓴다(연달아 나도 한 번). */
const ERROR_SAVE_DELAY_MS = 2_000;

/** JS 가 처음 읽힌 때 — 로딩 구간(첫 5초) 기준. */
const APP_STARTED_AT = Date.now();

const CSV: TelemetryFileName = 'telemetry.csv';
const ERRORS: TelemetryFileName = 'telemetry-errors.csv';
const PENDING: TelemetryFileName = 'telemetry-pending.json';

// ---------------------------------------------------------------------------
// 저장소 — 실행 환경별
// ---------------------------------------------------------------------------

interface SystemInfo {
  mobile: boolean;
  cores: number | null;
  ramMb: number | null;
  ramCapMb: number | null;
  os: string;
}

interface TelemetryStore {
  location(): Promise<string>;
  canOpenFolder: boolean;
  read(name: TelemetryFileName): Promise<string | null>;
  write(name: TelemetryFileName, text: string): Promise<void>;
  append(name: TelemetryFileName, text: string, header: string): Promise<void>;
  remove(name: TelemetryFileName): Promise<void>;
  /** 창이 닫히기 직전 동기 저장. 없는 환경(안드로이드)은 백그라운드 전환 때의 임시 기록으로 대신한다. */
  finishSync?(appends: TelemetryAppend[]): void;
  systemInfo(): Promise<SystemInfo>;
  memoryMb(): Promise<number | null>;
  /** 결과 문장, 취소면 null. */
  exportFiles(): Promise<string | null>;
  openFolder?(): Promise<void>;
}

/** 같은 파일에 대한 읽고-붙이기가 겹치지 않게 차례로. */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => {});
    return next;
  };
}

function desktopStore(): TelemetryStore | null {
  const t = desktopBridge()?.telemetry;
  if (!t) return null;
  return {
    location: () => t.folder(),
    canOpenFolder: true,
    read: (name) => t.read(name),
    write: (name, text) => t.write(name, text),
    append: (name, text, header) => t.append(name, text, header),
    remove: (name) => t.remove(name),
    finishSync: (appends) => t.finishSync(appends),
    async systemInfo() {
      const info = await t.systemInfo();
      return { mobile: false, cores: info.cores, ramMb: info.totalRamMb, ramCapMb: null, os: info.os };
    },
    memoryMb: () => t.memoryMb(),
    async exportFiles() {
      const saved = await t.exportFiles();
      return saved ? `저장했습니다: ${saved}` : null;
    },
    openFolder: () => t.openFolder(),
  };
}

function webStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function browserStore(): TelemetryStore {
  const key = (name: TelemetryFileName) => WEB_FILE_PREFIX + name;
  const get = (name: TelemetryFileName) => webStorage()?.getItem(key(name)) ?? null;
  const set = (name: TelemetryFileName, text: string) => webStorage()?.setItem(key(name), text);
  const add = (name: TelemetryFileName, text: string, header: string) => {
    const old = get(name);
    set(name, (old ? old : header) + text);
  };
  return {
    location: async () => '이 브라우저의 사이트 저장소(localStorage)',
    canOpenFolder: false,
    read: async (name) => get(name),
    write: async (name, text) => set(name, text),
    append: async (name, text, header) => add(name, text, header),
    remove: async (name) => webStorage()?.removeItem(key(name)),
    finishSync(appends) {
      for (const a of appends) add(a.name, a.text, a.header);
      webStorage()?.removeItem(key(PENDING));
    },
    async systemInfo() {
      const nav = (globalThis.navigator ?? {}) as Navigator & {
        deviceMemory?: number;
        userAgentData?: {
          mobile?: boolean;
          platform?: string;
          getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
        };
      };
      const ua = nav.userAgent ?? '';
      let platformVersion: string | undefined;
      try {
        platformVersion = (await nav.userAgentData?.getHighEntropyValues?.(['platformVersion']))?.platformVersion;
      } catch {
        // 알려 주지 않는 브라우저 — UA 로만 판단한다.
      }
      return {
        mobile: isMobileUserAgent(ua, nav.userAgentData?.mobile),
        cores: nav.hardwareConcurrency || null,
        ramMb: nav.deviceMemory ? nav.deviceMemory * 1024 : null,
        ramCapMb: 8 * 1024,
        os: browserOs(ua, { platform: nav.userAgentData?.platform, platformVersion }),
      };
    },
    async memoryMb() {
      const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
      return memory?.usedJSHeapSize ? memory.usedJSHeapSize / (1024 * 1024) : null;
    },
    async exportFiles() {
      const csv = get(CSV);
      if (!csv) return null;
      const base = `telemetry-${localDate(new Date())}`;
      downloadText(`${base}.csv`, csv);
      const errors = get(ERRORS);
      if (errors) downloadText(`${base}-errors.csv`, errors);
      return `${base}.csv 를 내려받았습니다. 다운로드 폴더에서 찾아 보내 주세요.`;
    },
  };
}

function nativeStore(): TelemetryStore {
  const dir = `${LegacyFileSystem.documentDirectory ?? ''}telemetry/`;
  const uri = (name: TelemetryFileName) => dir + name;
  const queue = serial();
  let madeDir = false;
  const ensureDir = async () => {
    if (madeDir) return;
    await LegacyFileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    madeDir = true;
  };
  const readFile = async (name: TelemetryFileName) => {
    try {
      return await LegacyFileSystem.readAsStringAsync(uri(name));
    } catch {
      return null;
    }
  };
  const readSys = async (path: string) => {
    try {
      return await LegacyFileSystem.readAsStringAsync(`file://${path}`);
    } catch {
      return null;
    }
  };
  return {
    location: async () => '앱 전용 저장 공간 (다른 앱에서 보이지 않음 — 내보내기로 꺼냅니다)',
    canOpenFolder: false,
    read: (name) => queue(() => readFile(name)),
    write: (name, text) =>
      queue(async () => {
        await ensureDir();
        await LegacyFileSystem.writeAsStringAsync(uri(name), text);
      }),
    // 파일이 작아(실행당 한 줄) 읽어서 다시 쓴다. 파일 작업은 네이티브 쪽에서 돌아 JS 스레드를 막지 않는다.
    append: (name, text, header) =>
      queue(async () => {
        await ensureDir();
        const old = await readFile(name);
        await LegacyFileSystem.writeAsStringAsync(uri(name), (old ? old : header) + text);
      }),
    remove: (name) => queue(() => LegacyFileSystem.deleteAsync(uri(name), { idempotent: true })),
    async systemInfo() {
      const [meminfo, possible] = await Promise.all([readSys('/proc/meminfo'), readSys('/sys/devices/system/cpu/possible')]);
      const constants = Platform.constants as { Release?: string };
      return {
        mobile: true,
        cores: possible ? parseCpuRange(possible) : null,
        ramMb: meminfo ? parseMemTotalMb(meminfo) : null,
        ramCapMb: null,
        os: Platform.OS === 'android' ? androidOs(constants.Release ?? Platform.Version) : iosOs(Platform.Version),
      };
    },
    async memoryMb() {
      if (Platform.OS !== 'android') return null;
      const status = await readSys('/proc/self/status');
      return status ? parseProcStatusRssMb(status) : null;
    },
    async exportFiles() {
      const csv = await readFile(CSV);
      if (!csv) return null;
      // 받는 쪽에서 알아보기 쉽게 날짜를 붙인 사본을 캐시 폴더에 만들어 공유 시트로 넘긴다.
      const copy = `${LegacyFileSystem.cacheDirectory ?? dir}telemetry-${localDate(new Date())}.csv`;
      await LegacyFileSystem.writeAsStringAsync(copy, csv);
      if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 공유 창을 열 수 없습니다.');
      await Sharing.shareAsync(copy, { mimeType: 'text/csv', dialogTitle: '실행 기록 보내기', UTI: 'public.comma-separated-values-text' });
      return '공유 창을 열었습니다. 메신저·메일로 보내 주세요.';
    },
  };
}

let storeCache: TelemetryStore | null = null;
function store(): TelemetryStore {
  if (!storeCache) storeCache = Platform.OS === 'web' ? (desktopStore() ?? browserStore()) : nativeStore();
  return storeCache;
}

// ---------------------------------------------------------------------------
// 동의 상태
// ---------------------------------------------------------------------------

let consent: TelemetryConsent = 'unset';
let consentReady = false;
const consentListeners = new Set<() => void>();

function emitConsent() {
  for (const listener of consentListeners) listener();
}

/** consent 상태를 구독한다. ready=false 면 아직 저장소에서 읽는 중 (그동안 동의 창을 띄우지 않는다). */
export function useTelemetryConsent(): { consent: TelemetryConsent; ready: boolean } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    consentListeners.add(listener);
    return () => {
      consentListeners.delete(listener);
    };
  }, []);
  return { consent, ready: consentReady };
}

async function deviceId(): Promise<string> {
  const saved = await AsyncStorage.getItem(DEVICE_KEY).catch(() => null);
  if (isUuid(saved)) return saved;
  const fresh = randomUuid();
  await AsyncStorage.setItem(DEVICE_KEY, fresh).catch(() => {});
  return fresh;
}

// ---------------------------------------------------------------------------
// 한 실행(세션)
// ---------------------------------------------------------------------------

interface Session {
  meta: TelemetryMeta;
  stats: RunStats;
  visible: boolean;
  lastTick: number;
  lastSave: number;
  frames: number;
  raf: number | null;
  timer: ReturnType<typeof setInterval> | null;
  memoryBusy: boolean;
  errorSaveTimer: ReturnType<typeof setTimeout> | null;
  /** 처리되지 않은 치명적 예외가 났다 — 이 뒤의 임시 기록은 모두 비정상 종료. */
  fatal: boolean;
  /** 디버그 강제 종료 중 — 닫힐 때 정상 종료 행을 쓰지 않는다. */
  crashing: boolean;
  finished: boolean;
  unsubscribe: (() => void)[];
}

let session: Session | null = null;
let starting: Promise<void> | null = null;

const isVisible = (state: AppStateStatus = AppState.currentState) => state === 'active';

function frame() {
  if (!session) return;
  session.frames += 1;
  session.raf = requestAnimationFrame(frame);
}

function tick() {
  const s = session;
  if (!s) return;
  const now = Date.now();
  const elapsed = now - s.lastTick;
  s.stats.addFpsSecond(s.frames, elapsed, now, s.visible);
  if (s.visible) s.stats.addActiveMs(elapsed);
  s.frames = 0;
  s.lastTick = now;
  if (!s.memoryBusy) {
    s.memoryBusy = true;
    store()
      .memoryMb()
      .then((mb) => session === s && s.stats.addRamSample(mb))
      .catch(() => {})
      .finally(() => {
        s.memoryBusy = false;
      });
  }
  if (now - s.lastSave >= SAVE_EVERY_MS) void savePending();
}

function pendingText(s: Session): string {
  const row = s.stats.toRow(s.meta, 0);
  return JSON.stringify(makePending(row, s.stats.errorTypes, s.visible ? 'active' : 'background', s.fatal));
}

async function savePending(): Promise<void> {
  const s = session;
  if (!s || s.finished) return;
  s.lastSave = Date.now();
  try {
    await store().write(PENDING, pendingText(s));
  } catch {
    // 다음 30초에 다시 쓴다.
  }
}

function onAppState(next: AppStateStatus) {
  const s = session;
  // 강제 종료 흉내 중이면 그대로 둔다 — 웹은 새로 고침하며 visibilitychange(hidden)가 먼저 와서, 여기서 저장하면
  // 임시 기록이 background(정상 종료)로 바뀌어 crashed=1 이 남지 않는다.
  if (!s || s.crashing) return;
  const visible = isVisible(next);
  if (visible === s.visible) return;
  // 바뀌기 전까지를 먼저 셈하고, 백그라운드로 가면 바로 저장한다 — 그 뒤에 OS 가 앱을 치워도 정상 종료로 남게.
  tick();
  s.visible = visible;
  s.frames = 0;
  s.lastTick = Date.now();
  void savePending();
}

/** 창이 닫힌다(웹·PC) — 정상 종료 행을 동기로 쓴다. */
function finishOnExit() {
  const s = session;
  if (!s || s.finished || s.crashing) return;
  const st = store();
  if (!st.finishSync) return;
  tick();
  s.finished = true;
  const row = s.stats.toRow(s.meta, 0);
  const appends: TelemetryAppend[] = [{ name: CSV, text: rowToCsv(row), header: TELEMETRY_HEADER }];
  const errors = errorTypesToCsv(row.session_id, s.stats.errorTypes);
  if (errors) appends.push({ name: ERRORS, text: errors, header: TELEMETRY_ERRORS_HEADER });
  try {
    st.finishSync(appends);
  } catch {
    // 못 썼으면 임시 기록이 남아 다음 실행이 옮긴다.
  }
  stopSession();
}

function stopSession() {
  const s = session;
  if (!s) return;
  if (s.raf != null) cancelAnimationFrame(s.raf);
  if (s.timer) clearInterval(s.timer);
  if (s.errorSaveTimer) clearTimeout(s.errorSaveTimer);
  for (const off of s.unsubscribe) off();
  session = null;
}

/** 지난 실행이 남긴 임시 기록을 CSV 로 옮긴다. */
async function recoverPrevious(st: TelemetryStore): Promise<void> {
  const recovered = recoverPending(await st.read(PENDING).catch(() => null));
  if (recovered) {
    await st.append(CSV, rowToCsv(recovered.row), TELEMETRY_HEADER);
    const errors = errorTypesToCsv(recovered.row.session_id, recovered.errorTypes);
    if (errors) await st.append(ERRORS, errors, TELEMETRY_ERRORS_HEADER);
  }
  await st.remove(PENDING).catch(() => {});
}

async function startSession(startedAt: number): Promise<void> {
  if (session) return;
  const st = store();
  await recoverPrevious(st).catch(() => {});
  const [id, info] = await Promise.all([deviceId(), st.systemInfo().catch(() => null)]);
  if (consent !== 'granted' || session) return;
  const meta: TelemetryMeta = {
    session_id: randomUuid(),
    device_id: id,
    date: localDate(new Date()),
    app_version: Constants.expoConfig?.version ?? '0.0.0',
    device_class: info ? classifyDevice(info) : Platform.OS === 'web' ? 'PC-저사양' : '모바일-보급형',
    os: info?.os ?? Platform.OS,
  };
  const now = Date.now();
  const s: Session = {
    meta,
    stats: new RunStats(startedAt),
    visible: isVisible(),
    lastTick: now,
    lastSave: now,
    frames: 0,
    raf: null,
    timer: null,
    memoryBusy: false,
    errorSaveTimer: null,
    fatal: false,
    crashing: false,
    finished: false,
    unsubscribe: [],
  };
  session = s;
  s.raf = requestAnimationFrame(frame);
  s.timer = setInterval(tick, SAMPLE_MS);
  const sub = AppState.addEventListener('change', onAppState);
  s.unsubscribe.push(() => sub.remove());
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.addEventListener('pagehide', finishOnExit);
    s.unsubscribe.push(() => window.removeEventListener('pagehide', finishOnExit));
  }
  await savePending();
}

function start(startedAt = Date.now()): Promise<void> {
  if (!starting) {
    starting = startSession(startedAt).finally(() => {
      starting = null;
    });
  }
  return starting;
}

// ---------------------------------------------------------------------------
// 에러 세기
// ---------------------------------------------------------------------------

/** 전역 핸들러가 기본 처리(콘솔 출력 포함)를 부르는 동안 — 같은 에러를 console.error 로 두 번 세지 않게. */
let inGlobalHandler = false;

function countError(type: string) {
  const s = session;
  if (!s || s.finished) return;
  s.stats.addError(type);
  if (!s.errorSaveTimer) {
    s.errorSaveTimer = setTimeout(() => {
      s.errorSaveTimer = null;
      void savePending();
    }, ERROR_SAVE_DELAY_MS);
  }
}

/** 잡은 예외를 센다 — 종류 이름만 남는다. 화면에서 실패를 처리한 곳(API 요청 실패, 화면 로딩 실패)이 부른다. */
export function recordCaughtError(err: unknown, type?: string): void {
  countError(type ?? errorTypeOf(err));
}

let hooksInstalled = false;
function installErrorHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // 에러 레벨 로그.
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (!inGlobalHandler) countError('console.error');
    original(...args);
  };

  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (event) => {
      // 이미지 같은 리소스 실패는 window 까지 올라오지 않는다(캡처 단계가 아님) — 여기는 스크립트 예외만.
      countError(errorTypeOf((event as ErrorEvent).error ?? 'Error'));
    });
    window.addEventListener('unhandledrejection', (event) => {
      countError(errorTypeOf((event as PromiseRejectionEvent).reason));
    });
    return;
  }

  // 네이티브: React Native 의 전역 예외 핸들러. 치명적이면 앱이 곧 꺼지므로 그 전에 한 번 더 저장한다.
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    countError(errorTypeOf(error));
    const pass = () => {
      inGlobalHandler = true;
      try {
        previous(error, isFatal);
      } finally {
        inGlobalHandler = false;
      }
    };
    if (!isFatal || !session) {
      pass();
      return;
    }
    session.fatal = true;
    // 저장이 끝나거나 0.5초가 지나면 원래 처리(앱 종료)로 넘긴다.
    void Promise.race([savePending(), new Promise((resolve) => setTimeout(resolve, 500))]).finally(pass);
  });
}

// ---------------------------------------------------------------------------
// 밖에서 부르는 것
// ---------------------------------------------------------------------------

let initialized = false;

/** 앱을 켤 때 한 번(_layout). 동의했으면 수집을 시작한다. 동의 전에는 아무것도 기록하지 않는다. */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;
  installErrorHooks();
  void AsyncStorage.getItem(CONSENT_KEY)
    .catch(() => null)
    .then((saved) => {
      consent = saved === 'granted' || saved === 'denied' ? saved : 'unset';
      consentReady = true;
      emitConsent();
      if (consent === 'granted') void start(APP_STARTED_AT);
    });
  // 웹: 뒤로 가기 캐시에서 되살아나면 새 실행으로 다시 잰다.
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted && consent === 'granted' && !session) void start();
    });
  }
}

/** 동의/거부/끄기/켜기. true 면 수집을 바로 시작, false 면 바로 멈춘다(이번 실행 기록은 버린다). */
export async function setTelemetryConsent(granted: boolean): Promise<void> {
  consent = granted ? 'granted' : 'denied';
  consentReady = true;
  emitConsent();
  await AsyncStorage.setItem(CONSENT_KEY, consent).catch(() => {});
  if (granted) {
    await start();
    return;
  }
  if (starting) await starting.catch(() => {});
  stopSession();
  await store().remove(PENDING).catch(() => {});
}

/** 쌓인 기록 파일을 모두 지운다. 수집 설정은 그대로이고, 기기 번호도 새로 만든다(지운 기록과 이어지지 않게). */
export async function deleteTelemetryRecords(): Promise<void> {
  const st = store();
  await Promise.all([st.remove(CSV), st.remove(ERRORS), st.remove(PENDING)]);
  await AsyncStorage.removeItem(DEVICE_KEY).catch(() => {});
  // 지금 실행 중인 기록은 새 기기 번호로 이어 간다.
  if (session) {
    session.meta = { ...session.meta, device_id: await deviceId() };
    void savePending();
  }
}

/** 기록 내보내기. 결과 문장, 취소면 null. 기록이 없으면 던진다. */
export async function exportTelemetry(): Promise<string | null> {
  const st = store();
  if (countCsvRows(await st.read(CSV)) === 0) throw new Error('아직 쌓인 기록이 없습니다.');
  return st.exportFiles();
}

/** 쌓인 행 수와 저장 위치 설명. */
export async function telemetryInfo(): Promise<{ rows: number; location: string; canOpenFolder: boolean }> {
  const st = store();
  const [csv, location] = await Promise.all([st.read(CSV).catch(() => null), st.location().catch(() => '')]);
  return { rows: countCsvRows(csv), location, canOpenFolder: st.canOpenFolder };
}

/** PC 앱만: 기록 폴더를 탐색기로 연다. */
export async function openTelemetryFolder(): Promise<void> {
  await store().openFolder?.();
}

/** 이번 실행의 지금까지 값(화면 확인용) — 수집 중이 아니면 null. */
export function currentTelemetrySnapshot() {
  return session ? session.stats.snapshot() : null;
}

/** 디버그: 잡힌 예외 1 + 에러 로그 1 + 처리되지 않은 예외 1 을 일으킨다(error_count 가 3 오른다). */
export function debugRaiseErrors(): void {
  try {
    throw new TypeError('telemetry debug: caught');
  } catch (err) {
    recordCaughtError(err);
  }
  console.error('[telemetry debug] 에러 레벨 로그');
  const uncaught = new RangeError('telemetry debug: uncaught');
  if (Platform.OS === 'web') {
    setTimeout(() => {
      throw uncaught;
    }, 0);
  } else {
    // 네이티브에서 타이머 안의 throw 는 치명적(앱 종료)이라, 치명적이지 않은 처리되지 않은 예외로 보고한다.
    (globalThis as { ErrorUtils?: { reportError(e: unknown): void } }).ErrorUtils?.reportError(uncaught);
  }
}

/** 디버그: 정리 없이 강제 종료한다(다음 실행에서 crashed=1). 웹은 정상 종료 표시 없이 새로 고침. */
export function debugCrash(): void {
  const s = session;
  if (s) s.crashing = true;
  tick();
  void savePending().finally(() => {
    const bridge = desktopBridge()?.telemetry;
    if (bridge) {
      bridge.debugCrash();
    } else if (Platform.OS === 'web') {
      window.location.reload();
    } else {
      // 처리되지 않은 치명적 예외 — 전역 핸들러가 한 번 더 저장한 뒤 앱이 꺼진다(개발 빌드는 빨간 화면).
      setTimeout(() => {
        throw new Error('telemetry debug: crash');
      }, 0);
    }
  });
}
