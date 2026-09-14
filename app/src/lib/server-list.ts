import { router } from 'expo-router';

/**
 * 서버 목록을 스택의 맨 아래로 연다 — 지금 서버의 화면을 모두 닫고 목록 하나만 남긴다.
 *
 * 서버를 바꾸면 스택에 남은 화면이 이전 서버의 저장소 id 와 데이터를 들고 남는다. 그 화면을
 * 전환 뒤에 걷어내려 하면, 로그인 상태가 바뀌며 보호 라우트가 화면을 걷어내는 것과 엇갈린다.
 * 목록을 여는 순간(사용자가 누른 때)은 로그인 상태가 그대로라 여기서 닫으면 엇갈릴 일이 없고,
 * 이후 전환 뒤에는 스택에 목록(과 그 위의 서버 폼)만 있다.
 */
export function openServerList(): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/servers');
}
