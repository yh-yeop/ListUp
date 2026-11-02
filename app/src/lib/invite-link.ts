import { router } from 'expo-router';
import { Platform } from 'react-native';
import { clearPendingInvite } from './pure/pending-invite';

/**
 * 초대 링크 — 서버 주소와 초대 코드를 한 번에 건넨다.
 *
 *   https://<서버>/join?code=ABCDE12345
 *
 * 서버가 주는 웹이 이 경로를 열어 로그인·가입 → 미리보기 → 참여를 이어 준다. 메신저는 `listup://`
 * 같은 사용자 정의 주소를 링크로 만들지 않는 경우가 많아 https 주소를 쓴다. 설치한 앱으로 넘기는
 * 주소(`listup://join?server=…&code=…`)는 그 웹 화면이 버튼으로 준다.
 */

export function inviteLinkFor(serverUrl: string, code: string): string {
  // 같은 오리진으로 빌드한 웹(서버 주소가 '')이면 지금 보고 있는 주소가 곧 서버다.
  const base = serverUrl || (Platform.OS === 'web' ? window.location.origin : '');
  return `${base.replace(/\/+$/, '')}/join?code=${encodeURIComponent(code)}`;
}

/** 설치한 앱에서 열기 — 앱이 이 서버를 목록에 더하고 들어가 참여까지 잇는다. */
export function appLinkFor(serverUrl: string, code: string): string {
  return `listup://join?server=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`;
}

/**
 * 같은 네트워크 안에서만 닿는 주소인지 — 공유기 안 주소(192.168.x, 10.x, 172.16–31.x),
 * 이 기기(localhost·127.x), `.local`. 밖에 있는 사람에게 이런 주소로 링크를 보내면 열리지 않는다.
 */
export function isLocalNetworkAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// 들고 가는 초대 코드(서버와 함께)는 node 에서 시험하려고 pure 로 뺐다.
export {
  clearPendingInvite,
  isUnusableInviteStatus,
  markPendingInviteSeen,
  peekPendingInvite,
  setPendingInvite,
  shouldAutoJoin,
} from './pure/pending-invite';

/**
 * 참여 화면을 떠날 때는 바로 지우지 않고 다음 차례에 지운다. 가입·로그인 직후 밑에 깔려 있던 참여 화면이
 * 잠깐 보였다가 첫 화면(index)이 보낸 새 참여 화면으로 바뀌는데, 그때 지우면 새 화면이 "바로 참여"를
 * 잃는다. 그 사이에 참여 화면이 다시 열리면 `keepPendingInvite` 가 취소한다.
 */
let clearTimer: ReturnType<typeof setTimeout> | null = null;

export function clearPendingInviteSoon(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    clearPendingInvite();
  }, 0);
}

export function keepPendingInvite(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
}

/**
 * 참여한(또는 이미 멤버인) 저장소를 연다 — 저장소 목록을 밑에 깔고. 링크로 들어와 로그인·가입하면 화면이
 * replace 로만 이어져 스택에 참여 화면 하나뿐이라, 그대로 replace 하면 저장소 화면에서 목록으로 돌아갈 길이
 * 없다(안드로이드 뒤로가기는 앱 종료). 목록에서 코드를 넣어 왔으면(뒤로 갈 곳이 있으면) 참여 화면만 바꾼다.
 * push 를 다음 차례로 미루는 것은 웹 때문이다 — 같은 차례에 replace·push 를 하면 브라우저 기록에 목록 대신
 * 참여 화면이 남아, 브라우저 뒤로가기가 참여 화면으로 간다.
 */
export function openJoinedRepo(repoId: string): void {
  clearPendingInvite();
  if (router.canGoBack()) {
    router.replace(`/repo/${repoId}`);
    return;
  }
  router.replace('/repos');
  setTimeout(() => router.push(`/repo/${repoId}`), 0);
}
