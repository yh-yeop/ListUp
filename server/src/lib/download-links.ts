import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 짧게 사는 다운로드 링크 — 로그인 헤더 없이 받을 수 있는 서명 URL.
 *
 * 앱이 파일을 받을 때 Authorization 헤더가 필요해서, 웹은 파일 전체를 메모리(Blob)로 받아야 했다.
 * 이 링크를 브라우저에 넘기면 브라우저가 직접 받는다 — 디스크로 바로 쓰고, 진행률을 보여 주고,
 * 끊기면 이어받는다(서버의 Range 지원).
 *
 * - 파일 하나(또는 폴더 zip 하나)·사용자 하나에 묶이고 몇 분 뒤 만료된다.
 * - 사용자의 토큰 세대를 담아, 비밀번호를 바꾸면 이미 나간 링크도 끊긴다.
 * - 받을 때 그 저장소에 아직 접근할 수 있는지 다시 본다(내보내진 사람의 링크는 쓸 수 없다).
 * - 로그인 토큰과 서명 문맥을 나눈다(`dl:`). 링크를 로그인 토큰으로, 토큰을 링크로 쓸 수 없다.
 */

export const DOWNLOAD_LINK_TTL_MS = 10 * 60 * 1000;

export interface DownloadLinkClaims {
  /** 사용자 */
  u: string;
  /** 토큰 세대 */
  ep: number;
  /** 저장소 */
  r: string;
  /** 파일 또는 폴더 경로. 폴더 zip 에서 '' 는 저장소 전체. */
  p: string;
  /** 스냅샷. null 이면 받는 시점의 head. */
  s: string | null;
  /** file: 파일 하나, archive: 폴더를 zip 으로 */
  k: 'file' | 'archive';
  /** 만료 시각(ms) */
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`dl:${body}`).digest('base64url');
}

export function issueDownloadLink(claims: Omit<DownloadLinkClaims, 'exp'>, secret: string, now = Date.now()) {
  const full: DownloadLinkClaims = { ...claims, exp: now + DOWNLOAD_LINK_TTL_MS };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return { token: `${body}.${sign(body, secret)}`, expiresAt: full.exp };
}

export function verifyDownloadLink(token: string, secret: string, now = Date.now()): DownloadLinkClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = Buffer.from(sign(body, secret), 'utf8');
  const actual = Buffer.from(token.slice(dot + 1), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DownloadLinkClaims;
    if (
      typeof claims.u !== 'string' ||
      typeof claims.r !== 'string' ||
      typeof claims.p !== 'string' ||
      typeof claims.ep !== 'number' ||
      typeof claims.exp !== 'number' ||
      (claims.k !== 'file' && claims.k !== 'archive') ||
      (claims.s !== null && typeof claims.s !== 'string')
    ) {
      return null;
    }
    if (claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
