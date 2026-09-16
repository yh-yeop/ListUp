import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** SQLite 파일 경로. `:memory:` 면 인메모리(테스트). */
  dbPath: string;
  /** blob 파일이 저장되는 디렉터리. */
  blobDir: string;
  /** 세션 토큰 서명 키. */
  authSecret: string;
  /** 토큰 유효기간(ms). */
  tokenTtlMs: number;
  /** CORS 허용 오리진. `*` 이면 전부 허용(개발용). 쉼표로 여러 개를 줄 수 있다. */
  corsOrigin: string;
  maxUploadBytes: number;
  /**
   * 저장소 하나의 총 용량 한도(바이트). 업로드·제안 생성·병합 결과가 이를 넘으면 413.
   * 음악·사진 폴더를 통째로 올리면 금방 GB 단위가 되므로 넉넉하게 잡는다.
   */
  maxRepoBytes: number;
  /** 사용자 한 명이 24시간 동안 저장소에 올릴 수 있는 blob 총량(바이트). 제안용 업로드에 적용한다. */
  maxStagingBytesPerDay: number;
  /** 웹 정적 빌드 디렉터리. index.html 이 있으면 API 와 같은 오리진으로 서빙한다. null 이면 끔. */
  webDir: string | null;
  /**
   * X-Forwarded-For 의 클라이언트 IP 를 믿을 프록시. fastify `trustProxy` 에 그대로 간다.
   * 기본은 이 PC(루프백)에서 붙은 프록시만 — 터널(cloudflared·Tailscale)은 같은 PC 에서 붙는다.
   * `true` 는 누구의 헤더든 믿고(앞단 프록시만 서버에 닿을 때), `false` 는 소켓 주소만 쓴다.
   */
  trustProxy: boolean | string[];
  /** 로그 레벨 (pino). */
  logLevel: string;
  /** 이 횟수만큼 로그인에 실패하면 잠시 막는다 (IP 기준·이메일 기준을 따로 센다). */
  loginFailureLimit: number;
  /** 마지막 실패로부터 이 시간이 지나면 실패 횟수를 잊는다(ms). */
  loginFailureWindowMs: number;
  /** 한도를 넘겼을 때 막아 두는 시간(ms). */
  loginBlockMs: number;
  /** 참조되지 않는 blob 을 지우기 전에 기다리는 시간(ms). 0 이면 GC 를 돌리지 않는다. */
  gcMinAgeMs: number;
  /** GC 를 도는 주기(ms). 0 이면 주기 실행을 하지 않는다(수동 `npm run gc` 는 가능). */
  gcIntervalMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 서버가 읽는 환경변수 전부. 여기 없는 `LISTUP_*` 는 오타로 보고 경고한다. */
const KNOWN_ENV = new Set([
  'LISTUP_DATA_DIR',
  'LISTUP_AUTH_SECRET',
  'LISTUP_HOST',
  'LISTUP_PORT',
  'LISTUP_DB_PATH',
  'LISTUP_BLOB_DIR',
  'LISTUP_TOKEN_TTL_DAYS',
  'LISTUP_CORS_ORIGIN',
  'LISTUP_MAX_UPLOAD_MB',
  'LISTUP_MAX_REPO_MB',
  'LISTUP_MAX_STAGING_MB_PER_DAY',
  'LISTUP_WEB_DIR',
  'LISTUP_TRUST_PROXY',
  'LISTUP_LOG_LEVEL',
  'LISTUP_LOGIN_FAILURE_LIMIT',
  'LISTUP_LOGIN_FAILURE_WINDOW_MIN',
  'LISTUP_LOGIN_BLOCK_MIN',
  'LISTUP_GC_MIN_AGE_HOURS',
  'LISTUP_GC_INTERVAL_HOURS',
]);

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** 정수 환경변수. 잘못된 값은 기본값으로 조용히 넘어가지 않고 기동을 막는다. */
function envInt(
  name: string,
  fallback: number,
  { min, max }: { min: number; max?: number },
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} 은(는) 정수여야 합니다: "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `${min} 이상이어야` : `${min}~${max} 사이여야`;
    throw new Error(`${name} 은(는) ${range} 합니다: ${value}`);
  }
  return value;
}

/** fastify(proxy-addr)가 이름으로 아는 대역. */
const PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * `LISTUP_TRUST_PROXY` — 없으면 `loopback`. `0`/`false` 끔, `1`/`true` 전부,
 * 그 밖에는 쉼표로 나눈 대역 이름(loopback·linklocal·uniquelocal)이나 IP·CIDR.
 */
function envTrustProxy(): boolean | string[] {
  const raw = process.env.LISTUP_TRUST_PROXY;
  if (!raw || !raw.trim()) return ['loopback'];
  const value = raw.trim().toLowerCase();
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    const validPrefix =
      prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (!PROXY_RANGES.has(entry) && (family === 0 || !validPrefix || extra !== undefined)) {
      throw new Error(
        `LISTUP_TRUST_PROXY 은(는) 0, 1, 또는 loopback·IP·CIDR 을 쉼표로 나눈 목록이어야 합니다: "${raw}"`,
      );
    }
  }
  return entries;
}

const warnedUnknownEnv = new Set<string>();

/** 이름을 잘못 쓴 `LISTUP_*` 변수는 무시되므로, 한 번씩 경고로 알려준다. */
function warnUnknownEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith('LISTUP_') || KNOWN_ENV.has(name) || warnedUnknownEnv.has(name)) continue;
    warnedUnknownEnv.add(name);
    console.warn(`알 수 없는 환경변수 ${name} — 이름을 확인하세요 (무시됩니다).`);
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  warnUnknownEnv();

  const dataDir = process.env.LISTUP_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const secret = process.env.LISTUP_AUTH_SECRET;

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('LISTUP_AUTH_SECRET 환경변수가 필요합니다 (production).');
  }

  const logLevel = process.env.LISTUP_LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LISTUP_LOG_LEVEL 은(는) ${LOG_LEVELS.join(', ')} 중 하나여야 합니다: "${logLevel}"`);
  }

  return {
    host: process.env.LISTUP_HOST ?? '0.0.0.0',
    port: envInt('LISTUP_PORT', 4000, { min: 1, max: 65535 }),
    dbPath: process.env.LISTUP_DB_PATH ?? path.join(dataDir, 'listup.db'),
    blobDir: process.env.LISTUP_BLOB_DIR ?? path.join(dataDir, 'blobs'),
    // 개발 환경에서 키를 안 주면 매 기동마다 새로 만든다 (= 재시작 시 로그아웃).
    authSecret: secret ?? randomBytes(32).toString('hex'),
    tokenTtlMs: envInt('LISTUP_TOKEN_TTL_DAYS', 30, { min: 1 }) * DAY,
    corsOrigin: process.env.LISTUP_CORS_ORIGIN ?? '*',
    // 앱은 조각으로 나눠 올리므로 프록시 요청 한도(Cloudflare 100MB)에 묶이지 않는다.
    maxUploadBytes: envInt('LISTUP_MAX_UPLOAD_MB', 2048, { min: 1 }) * 1024 * 1024,
    maxRepoBytes: envInt('LISTUP_MAX_REPO_MB', 4096, { min: 1 }) * 1024 * 1024,
    maxStagingBytesPerDay:
      envInt('LISTUP_MAX_STAGING_MB_PER_DAY', 1024, { min: 1 }) * 1024 * 1024,
    webDir: process.env.LISTUP_WEB_DIR ?? path.resolve(process.cwd(), '../app/dist'),
    trustProxy: envTrustProxy(),
    logLevel,
    loginFailureLimit: envInt('LISTUP_LOGIN_FAILURE_LIMIT', 10, { min: 1 }),
    loginFailureWindowMs: envInt('LISTUP_LOGIN_FAILURE_WINDOW_MIN', 15, { min: 1 }) * MINUTE,
    loginBlockMs: envInt('LISTUP_LOGIN_BLOCK_MIN', 15, { min: 1 }) * MINUTE,
    gcMinAgeMs: envInt('LISTUP_GC_MIN_AGE_HOURS', 24, { min: 0 }) * HOUR,
    gcIntervalMs: envInt('LISTUP_GC_INTERVAL_HOURS', 6, { min: 0 }) * HOUR,
    ...overrides,
  };
}
