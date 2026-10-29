/**
 * 사람이 적은 서버 주소를 확인해 볼 주소 후보로 — 순수 함수(app/test 가 node 에서 검사한다).
 *
 * 받는 사람은 보통 "192.168.0.10" 이나 "<내 노드>.<tailnet>.ts.net" 처럼 일부만 받아 적는다. 예전에는
 * http(s):// 와 포트까지 다 적어야 해서 여기서 막혔다. 앞에 올수록 그럴듯한 후보이고, 화면은 모두
 * 확인해 본 뒤 앞에서부터 처음 닿은 것을 쓴다.
 */

/** ListUp 서버의 기본 포트(`LISTUP_PORT`, PC 앱 기본값과 같다). */
export const DEFAULT_SERVER_PORT = 4000;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST_PORT_PATH = /^([^\s/:?#]+)(?::(\d{1,5}))?(\/\S*)?$/;

/** 공유기 안·이 기기 주소처럼 보통 http 로 바로 여는 곳. */
function looksLocal(host: string): boolean {
  const lower = host.toLowerCase();
  return IPV4.test(lower) || lower === 'localhost' || lower.endsWith('.local') || !lower.includes('.');
}

export function serverUrlCandidates(raw: string): string[] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return [];
  if (/^https?:\/\//i.test(trimmed)) {
    return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimmed) ? [trimmed] : [];
  }
  const match = HOST_PORT_PATH.exec(trimmed);
  if (!match) return [];
  const [, host, port, path = ''] = match;
  if (port) {
    const hostPort = `${host}:${port}${path}`;
    return looksLocal(host) ? [`http://${hostPort}`, `https://${hostPort}`] : [`https://${hostPort}`, `http://${hostPort}`];
  }
  if (looksLocal(host)) return [`http://${host}:${DEFAULT_SERVER_PORT}${path}`, `http://${host}${path}`];
  // 이름 있는 주소(터널·Tailscale·도메인)는 https 가 먼저다. 포트를 직접 연 서버일 수도 있어 4000 도 본다.
  return [`https://${host}${path}`, `http://${host}:${DEFAULT_SERVER_PORT}${path}`, `http://${host}${path}`];
}
