import { useCallback, useRef, useState } from 'react';

/**
 * 멈출 수 있는 작업 하나(올리기 등). `start` 가 새 신호를 주고, `cancel` 이 그 신호를 끊는다.
 * 끊은 뒤 작업이 실제로 멈출 때까지(보내던 조각을 끊고 정리) `cancelling` 이 참이다 — 버튼을 돌린다.
 */
export function useAbortable() {
  const controller = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const start = useCallback((): AbortSignal => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setCancelling(false);
    return next.signal;
  }, []);

  const cancel = useCallback(() => {
    const current = controller.current;
    if (!current || current.signal.aborted) return;
    current.abort();
    setCancelling(true);
  }, []);

  const finish = useCallback(() => {
    controller.current = null;
    setCancelling(false);
  }, []);

  return { start, cancel, finish, cancelling };
}
