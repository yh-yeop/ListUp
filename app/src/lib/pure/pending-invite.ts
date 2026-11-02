/**
 * 링크로 들어왔는데 아직 로그인(또는 서버 추가)이 필요할 때 들고 가는 초대 코드. 로그인·가입이 끝나면
 * 첫 화면(index)이 참여 화면으로 다시 보낸다. 앱을 새로 열면 사라진다.
 *
 * 코드는 **그 초대를 낸 서버**와 함께 든다. 들고 가는 동안 다른 서버로 바꿔 로그인하면 그 서버에서는 꺼내지
 * 않는다 — 안 그러면 엉뚱한 서버에 코드를 조회해 "초대 코드를 찾을 수 없습니다" 화면에 갇힌다.
 * `server` 는 화면이 쓰는 `serverUrl(entry)` 값 그대로다(같은 오리진 웹이면 빈 문자열일 수 있다).
 */
let pending: { code: string; server: string | null; seen: boolean } | null = null;

export function setPendingInvite(code: string, server: string | null): void {
  const same = pending?.code === code && pending.server === server;
  pending = { code, server, seen: same ? pending!.seen : false };
}

/** 지금 서버에서 이어 갈 초대 코드. 다른 서버의 것이면 null. */
export function peekPendingInvite(server: string | null): string | null {
  return pending && pending.server === server ? pending.code : null;
}

/** 그 초대가 어떤 저장소인지 미리보기로 보여 줬다 — 로그인·가입이 끝나면 다시 묻지 않고 바로 참여한다. */
export function markPendingInviteSeen(code: string): void {
  if (pending?.code === code) pending.seen = true;
}

/** 미리보기를 본 뒤 로그인·가입했으면 참여 화면이 버튼을 기다리지 않고 바로 참여한다. */
export function shouldAutoJoin(code: string): boolean {
  return pending !== null && pending.seen && pending.code === code;
}

export function clearPendingInvite(): void {
  pending = null;
}

/**
 * 초대 조회 오류가 "이 초대는 더 쓸 수 없다" 는 뜻인지 — 400 형식, 404 없는 코드, 409 회수·만료·소진·발급자 권한
 * 없음(server/src/routes/invites.ts). 연결 실패(0)·옛 서버의 로그인 요구(401)·잠시 막힘(429)은 다시 해 볼 수 있다.
 */
export function isUnusableInviteStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 409;
}
