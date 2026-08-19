import { randomBytes } from 'node:crypto';
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
  /** CORS 허용 오리진. `*` 이면 전부 허용(개발용). */
  corsOrigin: string;
  maxUploadBytes: number;
  /** 웹 정적 빌드 디렉터리. index.html 이 있으면 API 와 같은 오리진으로 서빙한다. null 이면 끔. */
  webDir: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = process.env.LISTUP_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const secret = process.env.LISTUP_AUTH_SECRET;

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('LISTUP_AUTH_SECRET 환경변수가 필요합니다 (production).');
  }

  return {
    host: process.env.LISTUP_HOST ?? '0.0.0.0',
    port: envInt('LISTUP_PORT', 4000),
    dbPath: process.env.LISTUP_DB_PATH ?? path.join(dataDir, 'listup.db'),
    blobDir: process.env.LISTUP_BLOB_DIR ?? path.join(dataDir, 'blobs'),
    // 개발 환경에서 키를 안 주면 매 기동마다 새로 만든다 (= 재시작 시 로그아웃).
    authSecret: secret ?? randomBytes(32).toString('hex'),
    tokenTtlMs: envInt('LISTUP_TOKEN_TTL_DAYS', 30) * DAY,
    corsOrigin: process.env.LISTUP_CORS_ORIGIN ?? '*',
    maxUploadBytes: envInt('LISTUP_MAX_UPLOAD_MB', 100) * 1024 * 1024,
    webDir: process.env.LISTUP_WEB_DIR ?? path.resolve(process.cwd(), '../app/dist'),
    ...overrides,
  };
}
