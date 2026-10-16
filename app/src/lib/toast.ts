/**
 * 화면 안 토스트. 업로드 결과·복사 완료·실패 같은 안내를 모달로 흐름을 끊지 않고 화면 아래에 잠시 띄운다.
 *
 * 화면 밖(라이브러리 함수)에서도 부를 수 있게 React 상태가 아니라 모듈 하나에 목록을 두고,
 * 루트의 `ToastHost` 가 구독해 그린다. 화면을 옮겨도(저장 → 뒤로 가기) 토스트는 남는다.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
  /** 이 시간(ms)이 지나면 저절로 사라진다. */
  durationMs: number;
}

/** 한꺼번에 보이는 최대 개수. 넘으면 오래된 것부터 내린다. */
const MAX_VISIBLE = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

/**
 * 읽을 시간을 글 길이에 맞춘다 — 짧은 "복사했습니다" 는 금방, 실패 목록은 오래.
 * 오류는 놓치면 안 되므로 조금 더 둔다.
 */
function durationFor(title: string, message: string | undefined, tone: ToastTone): number {
  const length = title.length + (message?.length ?? 0);
  const base = tone === 'error' || tone === 'warning' ? 5000 : 3000;
  return Math.min(base + length * 40, 12000);
}

export function showToast(title: string, message?: string, tone: ToastTone = 'info'): number {
  const id = nextId++;
  const toast: Toast = { id, title, message: message || undefined, tone, durationMs: durationFor(title, message, tone) };
  // 같은 안내가 이어서 오면(버튼을 두 번 누름) 하나만 둔다.
  toasts = [
    ...toasts.filter((item) => !(item.title === toast.title && item.message === toast.message)),
    toast,
  ].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== before) emit();
}

export function subscribeToasts(listener: (toasts: Toast[]) => void): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
