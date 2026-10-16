import { useEffect } from 'react';
import { AUTO_SYNC_EVERY_MS, runAllAutoSyncs, subscribeSync } from './sync-run';
import { notifySuccess, notifyWarning } from './dialogs';
import { describeOutcome } from './sync-run';

/**
 * 자동 맞추기 — 로그인돼 있는 동안 1분마다, 어느 화면에 있든(PC 앱은 창을 닫아 트레이에 있어도) 자동으로 둔 저장소들을
 * 맞춘다. 루트에서 한 번만 쓴다. 결과는 토스트로 알린다(바뀐 것이 있을 때만).
 */
export function useAutoSync(serverId: string | null, enabled: boolean): void {
  useEffect(() => {
    if (!serverId || !enabled) return;
    const timer = setInterval(() => void runAllAutoSyncs(serverId), AUTO_SYNC_EVERY_MS);
    const unsubscribe = subscribeSync((event) => {
      if (event.type !== 'auto-ran' || !event.outcome) return;
      const done = describeOutcome(event.outcome, true);
      if (event.outcome.failures.length > 0) notifyWarning(done ? `자동 맞추기 일부만 — ${done}` : '자동 맞추기가 실패했습니다.', event.outcome.failures[0]);
      else if (done) notifySuccess(`자동으로 맞췄습니다 — ${done}`);
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [serverId, enabled]);
}
