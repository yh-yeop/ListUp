import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SORT, parseSortOrder, serializeSortOrder, type SortOrder } from './pure/file-sort';

export {
  DEFAULT_SORT,
  nextSortOrder,
  sortDirs,
  sortFiles,
  type SortKey,
  type SortOrder,
} from './pure/file-sort';

const KEY = 'listup.fileSort';

/** 파일 목록 정렬 — 기기에 기억한다(모든 저장소 공통). 못 읽으면 이름순. */
export function useFileSort(): [SortOrder, (order: SortOrder) => void] {
  const [order, setOrder] = useState<SortOrder>(DEFAULT_SORT);
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!cancelled) setOrder(parseSortOrder(raw));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const change = useCallback((next: SortOrder) => {
    setOrder(next);
    void AsyncStorage.setItem(KEY, serializeSortOrder(next)).catch(() => undefined);
  }, []);
  return [order, change];
}
