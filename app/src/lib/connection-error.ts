/**
 * 서버에 닿지 못한 오류 문장 — client.ts 가 만들고, ErrorNotice 가 이 문장이면 「연결 문제 해결」로 가는 버튼을
 * 붙인다. 화면마다 오류를 문자열로 들고 있어서(ApiError 가 아니라) 문장 앞부분으로 알아본다.
 */
export const CONNECTION_FAILED = '서버에 연결할 수 없습니다.';
export const NO_RESPONSE = '서버 응답이 없습니다.';

export function isConnectionProblem(message: string): boolean {
  return message.startsWith(CONNECTION_FAILED) || message.startsWith(NO_RESPONSE);
}
