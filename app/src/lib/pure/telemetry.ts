/**
 * 실행 기록(텔레메트리)의 순수 로직 — 기기 분류·OS 이름·실행 통계·CSV 줄·남은 임시 기록 판정.
 * 화면·저장소·타이머는 lib/telemetry.ts 몫이고, 여기는 node 에서 바로 불러 검사한다(app/test/telemetry.test.ts).
 *
 * 실행 1회 = telemetry.csv 1행. 열은 TELEMETRY_COLUMNS 순서이고, 그 밖의 정보(이름·아이디·파일 경로·IP·입력·
 * 화면 내용·에러 메시지 원문)는 어떤 경로로도 행에 들어가지 않는다 — 에러는 종류 이름(sanitizeErrorType)과 개수만.
 */

export const TELEMETRY_COLUMNS = [
  'session_id',
  'device_id',
  'date',
  'app_version',
  'device_class',
  'os',
  'avg_fps',
  'min_fps_1s',
  'max_ram_mb',
  'duration_min',
  'error_count',
  'crashed',
] as const;

export const TELEMETRY_HEADER = `${TELEMETRY_COLUMNS.join(',')}\n`;
export const TELEMETRY_ERRORS_HEADER = 'session_id,error_type,count\n';

export interface TelemetryRow {
  session_id: string;
  device_id: string;
  /** YYYY-MM-DD (기기 현지 날짜, 시각은 없다). */
  date: string;
  app_version: string;
  device_class: string;
  os: string;
  /** 잴 수 없었으면 null → 빈 칸. */
  avg_fps: number | null;
  min_fps_1s: number | null;
  max_ram_mb: number | null;
  duration_min: number;
  error_count: number;
  crashed: 0 | 1;
}

/** 실행이 시작될 때 정해지는 값들. */
export type TelemetryMeta = Pick<TelemetryRow, 'session_id' | 'device_id' | 'date' | 'app_version' | 'device_class' | 'os'>;

/** 로딩 구간 — 실행 뒤 이만큼은 fps 를 재지 않는다. */
export const FPS_WARMUP_MS = 5_000;

// ---------------------------------------------------------------------------
// 기기 분류 (device_class)
// ---------------------------------------------------------------------------

/**
 * 기기 분류 기준 — 넓은 칸 넷만 둔다(모델명·GPU 이름 같은 세부는 남기지 않는다). README 「실행 기록」 절과 같다.
 *
 *   PC-고사양      논리 코어 8개 이상 그리고 RAM 16GB 이상 (OS 가 보고하는 총량 15GB 이상 — 표기 16GB 는 예약분을 빼면 15.x)
 *   PC-저사양      그 밖의 PC
 *   모바일-고급형  논리 코어 8개 이상 그리고 RAM 6GB 이상 (보고 총량 5.5GB 이상 — 표기 6GB 폰은 5.5GB 안팎으로 보인다)
 *   모바일-보급형  그 밖의 휴대폰·태블릿
 *
 * RAM 을 모르면(브라우저가 알려 주지 않음) 코어 수만 본다. 브라우저의 navigator.deviceMemory 는 8GB 에서 잘려
 * 나오므로(ramCapMb) 잘린 값 이상이면 RAM 기준을 채운 것으로 본다. GPU 는 브라우저·폰에서 등급을 믿을 만하게
 * 얻을 수 없어 기준에 넣지 않는다.
 */
export const DEVICE_CLASS_RULES = {
  pc: { minCores: 8, minRamMb: 15 * 1024 },
  mobile: { minCores: 8, minRamMb: 5.5 * 1024 },
} as const;

export function classifyDevice(input: {
  mobile: boolean;
  cores: number | null;
  ramMb: number | null;
  /** 이 값에서 잘려 보고되는 RAM(브라우저 8GB). */
  ramCapMb?: number | null;
}): string {
  const rule = input.mobile ? DEVICE_CLASS_RULES.mobile : DEVICE_CLASS_RULES.pc;
  const coresOk = (input.cores ?? 0) >= rule.minCores;
  let ramOk = true;
  if (input.ramMb != null && Number.isFinite(input.ramMb)) {
    ramOk = input.ramMb >= rule.minRamMb || (input.ramCapMb != null && input.ramMb >= input.ramCapMb);
  }
  const high = coresOk && ramOk;
  if (input.mobile) return high ? '모바일-고급형' : '모바일-보급형';
  return high ? 'PC-고사양' : 'PC-저사양';
}

// ---------------------------------------------------------------------------
// OS (종류 + 메이저 버전만)
// ---------------------------------------------------------------------------

function major(version: string | null | undefined): string | null {
  const m = /^\s*(\d+)/.exec(version ?? '');
  return m ? String(Number(m[1])) : null;
}

/** 안드로이드 Platform.constants.Release("14", "8.1.0") → "Android 14". */
export function androidOs(release: string | number | null | undefined): string {
  const v = major(release == null ? null : String(release));
  return v ? `Android ${v}` : 'Android';
}

/** iOS Platform.Version("17.4") → "iOS 17". */
export function iosOs(version: string | number | null | undefined): string {
  const v = major(version == null ? null : String(version));
  return v ? `iOS ${v}` : 'iOS';
}

/**
 * 브라우저의 OS. userAgent 는 Windows 11 을 "NT 10.0", 안드로이드를 "Android 10"(줄인 UA)으로 얼려 두므로,
 * 있으면 UA Client Hints 의 platformVersion 을 쓴다 — Windows 는 13 이상이 11, macOS·안드로이드는 앞자리가 버전.
 * 끝내 모르면 "Windows 10/11" 처럼 갈라지지 않는 이름으로 둔다.
 */
export function browserOs(userAgent: string, hints?: { platform?: string; platformVersion?: string } | null): string {
  const ua = userAgent || '';
  const platform = hints?.platform ?? '';
  const pv = major(hints?.platformVersion);
  if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) {
    if (pv != null) return Number(pv) >= 13 ? 'Windows 11' : Number(pv) > 0 ? 'Windows 10' : 'Windows';
    const nt = /Windows NT (\d+)\.(\d+)/.exec(ua);
    if (nt && nt[1] === '10') return 'Windows 10/11';
    if (nt && nt[1] === '6') return nt[2] === '1' ? 'Windows 7' : 'Windows 8';
    return 'Windows';
  }
  if (/Android/i.test(platform) || /Android/i.test(ua)) {
    if (pv != null) return `Android ${pv}`;
    return androidOs(/Android (\d+)/.exec(ua)?.[1]);
  }
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_/.exec(ua);
  if (ios) return `iOS ${Number(ios[1])}`;
  if (/mac/i.test(platform) || /Mac OS X/i.test(ua)) return pv != null ? `macOS ${pv}` : 'macOS';
  if (/CrOS/i.test(ua) || /Chrome OS/i.test(platform)) return 'ChromeOS';
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'Linux';
  return '기타';
}

/** 휴대폰·태블릿 브라우저인지 (UA Client Hints 의 mobile 이 있으면 그것). */
export function isMobileUserAgent(userAgent: string, hintMobile?: boolean): boolean {
  if (hintMobile != null) return hintMobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

// ---------------------------------------------------------------------------
// 날짜·ID
// ---------------------------------------------------------------------------

/** 기기 현지 날짜 YYYY-MM-DD. 시각은 남기지 않는다. */
export function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 랜덤 UUID v4. 하드웨어·계정과 무관한 난수다. crypto 가 없으면(Hermes) Math.random — 겹치지만 않으면 되는 ID 라
 * 암호학적 강도는 필요 없다.
 */
export function randomUuid(random: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (random === Math.random && typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (random === Math.random && typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// 에러 종류
// ---------------------------------------------------------------------------

/**
 * 에러의 종류 이름만 — 예외 클래스 이름(TypeError, ApiError.503 …). 메시지는 보지 않는다.
 * 이름도 아무 문자열이나 될 수 있으므로 영문·숫자·`._-` 만 남기고 40자로 자른다(한글·경로·공백이 섞이면 'Error').
 */
export function sanitizeErrorType(raw: string | null | undefined): string {
  const clean = (raw ?? '').trim();
  if (!clean || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(clean)) return 'Error';
  return clean.slice(0, 40);
}

/** 던져진 값의 종류 이름. */
export function errorTypeOf(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? err.name : err.constructor?.name;
    return sanitizeErrorType(name || 'Error');
  }
  if (typeof err === 'string') return 'String';
  if (err === null) return 'Null';
  return sanitizeErrorType(typeof err === 'object' ? (err as object).constructor?.name ?? 'Object' : typeof err);
}

// ---------------------------------------------------------------------------
// 실행 통계
// ---------------------------------------------------------------------------

/** 30초마다 덮어쓰는 임시 기록(telemetry-pending.json)의 내용. */
export interface TelemetryPending {
  v: 1;
  row: TelemetryRow;
  errorTypes: Record<string, number>;
  /**
   * 마지막으로 저장할 때 앱이 어디 있었나. background 면 그 뒤에 OS 가 앱을 치운 것은 정상 종료로 본다 —
   * 안드로이드는 최근 앱에서 밀어 끄면 JS 가 아무 신호도 못 받기 때문이다. active 로 남았으면 비정상 종료.
   */
  state: 'active' | 'background';
  /** 처리되지 않은 치명적 예외 직후 저장했다 — state 와 상관없이 비정상 종료. */
  fatal?: boolean;
}

/**
 * 한 실행의 측정값을 모은다. 시간은 밖에서 넣어 준다(테스트에서 시계를 흉내 내려고).
 *  - fps: 1초마다 그 1초의 fps 하나. 실행 뒤 FPS_WARMUP_MS 안이거나 화면이 안 보이던 1초는 뺀다
 *    (안 보이면 브라우저·OS 가 그리기를 멈춰 0 이 찍힌다)
 *  - 메모리: 1초마다 하나, 최댓값만
 *  - 실행 시간: 화면에 보이던 시간만 더한다(백그라운드에 몇 시간 놓아 둔 것을 실행 시간으로 치지 않는다)
 */
export class RunStats {
  private fpsSum = 0;
  private fpsCount = 0;
  private fpsMin: number | null = null;
  private ramMax: number | null = null;
  private activeMs = 0;
  private errors = 0;
  readonly errorTypes: Record<string, number> = {};

  constructor(private readonly startedAt: number) {}

  /** 지난 elapsedMs 동안 그린 frames. 지금 시각 now. */
  addFpsSecond(frames: number, elapsedMs: number, now: number, visible: boolean): void {
    if (!visible || elapsedMs <= 0) return;
    if (now - this.startedAt < FPS_WARMUP_MS) return;
    // 타이머가 크게 밀렸으면(기기가 잠들었다 깸) 그 구간은 믿을 수 없다.
    if (elapsedMs > 3_000) return;
    const fps = (frames * 1000) / elapsedMs;
    this.fpsSum += fps;
    this.fpsCount += 1;
    this.fpsMin = this.fpsMin == null ? fps : Math.min(this.fpsMin, fps);
  }

  addRamSample(mb: number | null): void {
    if (mb == null || !Number.isFinite(mb) || mb <= 0) return;
    this.ramMax = this.ramMax == null ? mb : Math.max(this.ramMax, mb);
  }

  addActiveMs(ms: number): void {
    if (ms > 0 && Number.isFinite(ms)) this.activeMs += ms;
  }

  addError(type: string): void {
    this.errors += 1;
    const key = sanitizeErrorType(type);
    this.errorTypes[key] = (this.errorTypes[key] ?? 0) + 1;
  }

  get errorCount(): number {
    return this.errors;
  }

  snapshot() {
    return {
      avgFps: this.fpsCount ? round1(this.fpsSum / this.fpsCount) : null,
      minFps: this.fpsMin == null ? null : round1(this.fpsMin),
      maxRamMb: this.ramMax == null ? null : round1(this.ramMax),
      durationMin: round1(this.activeMs / 60_000),
      errorCount: this.errors,
    };
  }

  toRow(meta: TelemetryMeta, crashed: 0 | 1): TelemetryRow {
    const s = this.snapshot();
    return {
      ...meta,
      avg_fps: s.avgFps,
      min_fps_1s: s.minFps,
      max_ram_mb: s.maxRamMb,
      duration_min: s.durationMin,
      error_count: s.errorCount,
      crashed,
    };
  }
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다(값은 우리가 만든 것뿐이라 거의 없지만). */
export function csvField(value: string | number | null): string {
  if (value == null) return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowToCsv(row: TelemetryRow): string {
  return `${TELEMETRY_COLUMNS.map((column) => csvField(row[column])).join(',')}\n`;
}

/** 에러 종류별 개수 → telemetry-errors.csv 줄들. 없으면 빈 문자열. */
export function errorTypesToCsv(sessionId: string, errorTypes: Record<string, number>): string {
  return Object.entries(errorTypes)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${csvField(sessionId)},${csvField(sanitizeErrorType(type))},${count}\n`)
    .join('');
}

/** 헤더를 뺀 데이터 행 수. */
export function countCsvRows(text: string | null): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length && lines[0].replace(/^﻿/, '').startsWith('session_id,')) lines.shift();
  return lines.length;
}

// ---------------------------------------------------------------------------
// 남은 임시 기록
// ---------------------------------------------------------------------------

export function makePending(row: TelemetryRow, errorTypes: Record<string, number>, state: 'active' | 'background', fatal = false): TelemetryPending {
  return { v: 1, row, errorTypes: { ...errorTypes }, state, ...(fatal ? { fatal: true } : {}) };
}

/**
 * 지난 실행이 남긴 임시 기록을 CSV 에 옮길 행으로. 정상 종료했다면 임시 기록은 지워졌으므로, 남아 있다는 것은
 * 마지막 저장 뒤에 끝났다는 뜻이다 — 화면에 떠 있던 중(active)이거나 치명적 예외 직후면 crashed=1,
 * 백그라운드로 내려간 뒤(OS 가 치움)면 0. 읽을 수 없는 내용이면 null(버린다).
 */
export function recoverPending(text: string | null): { row: TelemetryRow; errorTypes: Record<string, number> } | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const p = parsed as Partial<TelemetryPending> | null;
  if (!p || p.v !== 1 || !p.row || !isUuid(p.row.session_id)) return null;
  const row = p.row;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const crashed: 0 | 1 = p.fatal || p.state !== 'background' ? 1 : 0;
  const errorTypes: Record<string, number> = {};
  for (const [type, count] of Object.entries(p.errorTypes ?? {})) {
    if (typeof count === 'number' && count > 0) errorTypes[sanitizeErrorType(type)] = Math.floor(count);
  }
  return {
    row: {
      session_id: row.session_id,
      device_id: isUuid(row.device_id) ? row.device_id : '',
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)) ? row.date : '',
      app_version: String(row.app_version ?? ''),
      device_class: String(row.device_class ?? ''),
      os: String(row.os ?? ''),
      avg_fps: num(row.avg_fps),
      min_fps_1s: num(row.min_fps_1s),
      max_ram_mb: num(row.max_ram_mb),
      duration_min: num(row.duration_min) ?? 0,
      error_count: Math.max(0, Math.floor(num(row.error_count) ?? 0)),
      crashed,
    },
    errorTypes,
  };
}

// ---------------------------------------------------------------------------
// 리눅스·안드로이드 /proc 읽기
// ---------------------------------------------------------------------------

/** /proc/self/status 의 VmRSS(kB) → MB. 없으면 null. */
export function parseProcStatusRssMb(text: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return m ? round1(Number(m[1]) / 1024) : null;
}

/** /proc/meminfo 의 MemTotal(kB) → MB. */
export function parseMemTotalMb(text: string): number | null {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** /sys/devices/system/cpu/possible ("0-7", "0-3,6-7") → 코어 수. */
export function parseCpuRange(text: string): number | null {
  let count = 0;
  for (const part of text.trim().split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    count += m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1;
  }
  return count || null;
}

// ---------------------------------------------------------------------------
// 알리는 문장
// ---------------------------------------------------------------------------

/** 기록하는 항목과 이유 — 동의 창·실행 기록 화면이 같은 문장을 보인다. */
export const TELEMETRY_ITEMS: { label: string; why: string }[] = [
  { label: '실행 번호(session_id)·기기 번호(device_id)', why: '실행마다·기기마다 새로 만든 무작위 번호. 같은 기기의 실행을 묶어 보려고 (하드웨어 ID·계정과 무관)' },
  { label: '날짜(시각 제외)·앱 버전', why: '버전·시기별로 오류가 달라지는지 보려고' },
  { label: '기기 분류(PC-저사양/고사양, 모바일-보급형/고급형)·OS 이름과 메이저 버전', why: '어떤 실행 환경에서 오류가 몰리는지 보려고 — 모델명은 남기지 않음' },
  { label: '평균·최저 fps, 최대 메모리(MB)', why: '느려지거나 메모리를 많이 쓰는 환경을 찾으려고' },
  { label: '실행 시간(분)·에러 수·비정상 종료 여부', why: '오래 쓸수록·어떤 환경에서 오류와 강제 종료가 잦은지 보려고 (에러는 종류 이름별 개수만)' },
];

/** 기록하지 않는 것 — 동의 창과 「실행 기록」 화면이 같은 목록을 보인다. */
export const TELEMETRY_NOT_RECORDED: string[] = [
  '이름·아이디·이메일',
  '파일 이름과 경로, 파일 내용',
  'IP 주소와 서버 주소',
  '입력한 내용과 화면에 보이는 내용',
  '에러 메시지 원문 (종류 이름별로 몇 번 났는지만 셉니다)',
  '기기 모델명·하드웨어 ID·MAC 주소',
];
