/**
 * 화면 안 토스트 — 흐름을 끊지 않는 짧은 안내. `notify`(lib/dialogs.ts)가 여기에 넣고,
 * 루트 레이아웃의 `ToastHost` 가 그린다. 화면을 옮겨도 안내가 남도록 상태를 화면 밖에 둔다.
 */

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
}

/** 한 번에 보이는 최대 개수. 넘으면 오래된 것부터 내린다. */
const MAX_VISIBLE = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

/** 읽을 시간 — 글이 길수록, 실패일수록 오래 둔다. */
function durationOf(toast: Toast): number {
  const length = toast.title.length + (toast.message?.length ?? 0);
  const base = toast.tone === 'error' ? 6000 : 3500;
  return Math.min(12_000, base + length * 40);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function showToast(input: Omit<Toast, 'id'>): void {
  // 같은 안내가 이미 떠 있으면(같은 버튼을 연달아 누름) 새로 쌓지 않고 그것을 다시 띄운다.
  const same = toasts.find(
    (toast) => toast.title === input.title && toast.message === input.message && toast.tone === input.tone,
  );
  if (same) dismissToast(same.id);

  const toast: Toast = { ...input, id: nextId++ };
  toasts = [...toasts, toast];
  while (toasts.length > MAX_VISIBLE) dismissToast(toasts[0].id);
  timers.set(
    toast.id,
    setTimeout(() => dismissToast(toast.id), durationOf(toast)),
  );
  emit();
}

export function subscribeToasts(listener: (toasts: Toast[]) => void): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
