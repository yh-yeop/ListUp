import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { notifyError } from './dialogs';

export interface Page<T, C> {
  items: T[];
  /** 더 볼 게 있으면 다음 요청에 넘길 커서, 없으면 null. */
  next: C | null;
}

export interface MorePages<T, C> {
  /** 첫 페이지 + 이어 받은 페이지. */
  items: T[];
  next: C | null;
  loadingMore: boolean;
  loadMore(): void;
  /** 이어 받은 것을 버린다 — 목록을 바꾸는 동작 뒤 새로고침과 함께. */
  reset(): void;
}

/**
 * '더 보기' 로 이어 받는 목록. 첫 페이지는 화면의 useAsync 가 받고, 그 뒤 페이지를 여기 모은다.
 * 이어 받은 것은 그 첫 페이지(`first.items` 참조)에 묶어 두어, 새로고침이나 필터 변경으로 첫 페이지가
 * 바뀌면 저절로 버려진다.
 */
export function useMorePages<T, C>(
  first: Page<T, C> | null | undefined,
  fetchPage: (cursor: C) => Promise<Page<T, C>>,
): MorePages<T, C> {
  const [extra, setExtra] = useState<(Page<T, C> & { from: T[] }) | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const firstItems = first?.items;
  const current = extra && extra.from === firstItems ? extra : null;
  const items = [...(firstItems ?? []), ...(current?.items ?? [])];
  const next = current ? current.next : (first?.next ?? null);

  async function loadMore() {
    if (!firstItems || next === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchRef.current(next);
      setExtra((prev) => ({
        from: firstItems,
        items: [...(prev && prev.from === firstItems ? prev.items : []), ...page.items],
        next: page.next,
      }));
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '더 불러오지 못했습니다.');
    } finally {
      setLoadingMore(false);
    }
  }

  return {
    items,
    next,
    loadingMore,
    loadMore: () => void loadMore(),
    reset: () => setExtra(null),
  };
}
