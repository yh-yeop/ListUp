import { useEffect, useState } from 'react';

/**
 * 계정 안내 — 로그인·가입·재설정 화면은 성공하면 보호 라우트가 바로 내려 버려, 그 화면에서는 결과를 보여줄 수
 * 없다(예: 복구 코드로 찾은 아이디). 다음 화면이 읽도록 화면 밖에 한 건만 둔다. 앱을 다시 열면 사라진다.
 *
 * - recovered: 코드로 새 비밀번호를 정했다 → 저장소 목록이 아이디·남은 복구 코드를 알린다.
 * - signed-up: 막 가입했다 → 저장소 목록이 복구 코드를 만들어 두라고 권한다.
 * - session-ended: 401 로 로그인이 끊겼다 → 로그인 화면이 이유를 알린다.
 */
export type AccountNotice =
  | { kind: 'recovered'; loginId: string; codesLeft: number | null }
  | { kind: 'signed-up' }
  | { kind: 'session-ended' };

let current: AccountNotice | null = null;
const listeners = new Set<(notice: AccountNotice | null) => void>();

export function setAccountNotice(notice: AccountNotice | null): void {
  current = notice;
  for (const listener of listeners) listener(current);
}

export function clearAccountNotice(kind?: AccountNotice['kind']): void {
  if (kind && current?.kind !== kind) return;
  setAccountNotice(null);
}

/** 지금 안내 중 그 종류만. 다른 종류면 null. */
export function useAccountNotice<K extends AccountNotice['kind']>(
  kind: K,
): Extract<AccountNotice, { kind: K }> | null {
  const [notice, setNotice] = useState(current);
  useEffect(() => {
    listeners.add(setNotice);
    setNotice(current);
    return () => {
      listeners.delete(setNotice);
    };
  }, []);
  return notice?.kind === kind ? (notice as Extract<AccountNotice, { kind: K }>) : null;
}
