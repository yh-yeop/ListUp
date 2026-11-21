/**
 * 새로고침이 실패했을 때 받아 둔 목록을 지울지 — 순수 함수(app/test 가 검사, useAsync 가 쓴다).
 *
 * 예전에는 당겨서 새로고침·R·다른 화면에 다녀온 뒤의 다시 읽기가 한 번 실패하면 목록 자리가 오류로 바뀌었다(REFACTOR U2-12).
 * 와이파이가 잠깐 끊긴 것만으로 보던 목록이 사라지면 다시 찾아 들어가야 한다. 연결 문제(응답 없음·연결 안 됨, status 0)와
 * 서버 쪽 일시 오류(5xx)면 목록을 그대로 두고 토스트로 알린다. 403·404 처럼 "더는 볼 수 없다"는 답은 옛 목록을 보이면
 * 거짓이 되므로 예전처럼 오류로 바꾼다. 처음 불러오기(목록이 없음)와 이미 오류를 보이는 중이면 늘 오류 자리.
 */
export function keepDataOnRefreshFailure(input: {
  mode: 'initial' | 'refresh';
  hasData: boolean;
  showingError: boolean;
  /** ApiError 의 status. ApiError 가 아니면 undefined(알 수 없는 실패 — 일시적인 것으로 본다). */
  status: number | undefined;
}): boolean {
  if (input.mode !== 'refresh' || !input.hasData || input.showingError) return false;
  const status = input.status;
  return status === undefined || status === 0 || status >= 500;
}
