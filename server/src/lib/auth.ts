import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { MAX_LOGIN_ID_LENGTH, MIN_LOGIN_ID_LENGTH } from '@listup/shared';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/** scryptSync 는 수십 ms 동안 이벤트 루프를 막으므로 스레드풀에서 도는 비동기 버전을 쓴다. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, params, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** `scrypt$N$r$p$salt$hash` 형태로 파라미터를 함께 저장한다. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// 토큰: `base64url(payload).base64url(hmac)` — 상태를 서버에 두지 않는다.
// ---------------------------------------------------------------------------

interface TokenPayload {
  sub: string;
  exp: number;
  /** 토큰 세대. 비밀번호를 바꾸면 사용자의 세대가 올라가 이전 토큰이 한 번에 무효가 된다. */
  ep?: number;
}

/** 토큰에서 확인한 사용자와 세대. */
export interface TokenClaims {
  userId: string;
  epoch: number;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(
  userId: string,
  secret: string,
  ttlMs: number,
  epoch: number = 0,
): string {
  const payload: TokenPayload = { sub: userId, exp: Date.now() + ttlMs, ep: epoch };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * 서명과 만료를 확인한다. 유효하면 사용자와 세대, 아니면 null.
 * 세대가 지금도 맞는지는 사용자 행을 읽는 쪽(app.ts)에서 비교한다.
 */
export function verifyToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): TokenClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(body, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= now) return null;
    // ep 가 없는 토큰은 세대 도입 전에 나간 것이라 0 세대로 본다.
    const epoch = typeof payload.ep === 'number' ? payload.ep : 0;
    return { userId: payload.sub, epoch };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 입력 검증
// ---------------------------------------------------------------------------

/**
 * 로그인 아이디. 1.5 까지는 "이메일"이라고 불렀지만 메일을 보낸 적이 없다 — 서버마다 따로인 계정의
 * 아이디일 뿐이다. DB 의 칸(users.email)과 API 의 필드 이름(`email`)은 1.5 까지의 앱이 그 이름으로
 * 보내므로 그대로 두고, 뜻만 "로그인 아이디"로 바꿨다.
 *
 * 정리는 앞뒤 공백을 떼고, 유니코드 NFC(맥·안드로이드가 분해형으로 주는 한글), 소문자. 예전 이메일
 * 계정은 이 정리를 거쳐도 같은 값이라 그대로 로그인된다.
 */
export function normalizeLoginId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const id = input.trim().normalize('NFC').toLowerCase();
  // 로그인·재설정에서는 예전에 받아 준 모양(이메일 254자까지)도 찾아야 하므로 넉넉하게.
  if (id.length < 1 || id.length > 254 || /[\s\p{Cc}]/u.test(id)) return null;
  return id;
}

/** 예전 가입 규칙 — 이메일 모양. 이렇게 만든 계정도 계속 새로 만들 수 있다. */
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 새 아이디 — 글자·숫자로 시작하고 글자·숫자와 `. _ - @ +` 만. */
const LOGIN_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._@+-]*$/u;

/** 가입할 때의 아이디. 규칙에 맞지 않으면 null. */
export function validateNewLoginId(input: unknown): string | null {
  const id = normalizeLoginId(input);
  if (!id) return null;
  const length = [...id].length;
  const asId = length >= MIN_LOGIN_ID_LENGTH && length <= MAX_LOGIN_ID_LENGTH && LOGIN_ID_RE.test(id);
  const asEmail = id.length >= 5 && EMAIL_SHAPE_RE.test(id);
  return asId || asEmail ? id : null;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function validatePassword(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length < MIN_PASSWORD_LENGTH || input.length > MAX_PASSWORD_LENGTH) return null;
  return input;
}
