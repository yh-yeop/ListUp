import { API_VERSION, type HealthResponse } from '@listup/shared';
import type { ClientOptions } from './client.ts';

/**
 * MCP 서버 설정 — MCP 클라이언트(Claude 등)가 서버 프로세스에 넘겨 주는 환경변수로만 받는다.
 *
 *   LISTUP_URL                          서버 주소 (`https://…`, 끝의 /api 는 있어도 된다)
 *   LISTUP_TOKEN                        로그인 토큰 — 또는
 *   LISTUP_USERNAME / LISTUP_PASSWORD   아이디·비밀번호 (`npm run sync` 처럼 LISTUP_EMAIL 도 아이디로 받는다)
 *
 * 둘 다 주면 토큰을 먼저 쓰고, 만료되면 아이디·비밀번호로 다시 로그인한다.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ClientOptions {
  const baseUrl = env.LISTUP_URL?.trim();
  if (!baseUrl) throw new Error('LISTUP_URL 환경변수에 ListUp 서버 주소를 주세요 (예: https://<내 노드>.<tailnet>.ts.net).');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('LISTUP_URL 은 http:// 나 https:// 로 시작해야 합니다.');
  const token = env.LISTUP_TOKEN?.trim() || null;
  const username = (env.LISTUP_USERNAME ?? env.LISTUP_EMAIL)?.trim();
  const password = env.LISTUP_PASSWORD;
  if (!token && !(username && password)) {
    throw new Error('LISTUP_TOKEN 이나 LISTUP_USERNAME·LISTUP_PASSWORD 를 주세요. AI 전용 계정을 열람자로 초대해 쓰기를 권합니다.');
  }
  return { baseUrl, token, credentials: username && password ? { username, password } : null };
}

/** 이 MCP 서버가 쓰는 기능(나눠 올리기)이 있는 가장 낮은 서버 수준. */
export const MIN_SERVER_API_LEVEL = 2;

/** `/api/health` 를 보고 붙을 수 있는 서버인지. 안 되면 사람이 읽을 이유, 되면 null. */
export function checkServer(health: Partial<HealthResponse>): string | null {
  // 필드가 없는 서버는 1 로 본다(docs/API.md).
  const apiVersion = health.apiVersion ?? 1;
  const apiLevel = health.apiLevel ?? 1;
  if (apiVersion !== API_VERSION) {
    return `서버 API 버전(${apiVersion})이 이 MCP 서버(${API_VERSION})와 달라 쓸 수 없습니다. 서버와 리포를 같은 버전으로 맞춰 주세요.`;
  }
  if (apiLevel < MIN_SERVER_API_LEVEL) {
    return `서버가 오래됐습니다(기능 수준 ${apiLevel}, ${MIN_SERVER_API_LEVEL} 이상 필요). 서버를 업데이트해 주세요.`;
  }
  return null;
}
