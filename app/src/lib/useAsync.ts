import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { notifyError } from './dialogs';
import { keepDataOnRefreshFailure } from './pure/refresh-failure';
import { recordCaughtError } from './telemetry';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** 당겨서 새로고침 중인지 (첫 로딩과 구분). */
  refreshing: boolean;
  reload(): void;
  refresh(): void;
}

/**
 * 화면에서 데이터를 불러올 때 쓰는 공통 훅.
 * deps 가 바뀌면 다시 불러오고, 이전 요청 결과가 늦게 도착해도 무시한다. 새로고침(refresh)이 연결 문제로 실패하면
 * 받아 둔 data 를 지우지 않고 토스트로 알린다.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestId = useRef(0);
  // 실패했을 때 받아 둔 목록을 지킬지 보려고(run 은 한 번만 만든다).
  const shown = useRef({ hasData: false, showingError: false });
  shown.current = { hasData: data !== null, showingError: error !== null };
  // deps 가 바뀐 횟수와, 지금 data 가 몇 번째 deps 로 받은 것인지 — 폴더를 옮긴 직후의 실패에 옛 폴더 목록을 지키지 않게.
  const depsGen = useRef(0);
  const dataGen = useRef(-1);

  const run = useCallback(async (mode: 'initial' | 'refresh') => {
    const id = ++requestId.current;
    const gen = depsGen.current;
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);

    try {
      const result = await loaderRef.current();
      if (id !== requestId.current) return;
      dataGen.current = gen;
      setData(result);
      setError(null);
    } catch (err) {
      // API 실패는 api/client 가 이미 셌다 — 그 밖의 예외(화면 로딩 코드의 버그)만 실행 기록에 센다.
      if (!(err instanceof ApiError)) recordCaughtError(err);
      if (id !== requestId.current) return;
      const message = err instanceof ApiError ? err.message : '불러오지 못했습니다.';
      // 연결이 잠깐 끊겨 새로고침만 실패했으면 보던 목록을 지우지 않고 알리기만 한다(lib/pure/refresh-failure.ts).
      const keep = keepDataOnRefreshFailure({
        mode,
        ...shown.current,
        dataForCurrentDeps: dataGen.current === depsGen.current,
        status: err instanceof ApiError ? err.status : undefined,
      });
      if (keep) {
        notifyError('새로 고치지 못했습니다 — 보던 목록을 그대로 둡니다.', message);
        return;
      }
      setError(message);
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    depsGen.current += 1;
    void run('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    data,
    error,
    loading,
    refreshing,
    reload: () => void run('initial'),
    refresh: () => void run('refresh'),
  };
}
