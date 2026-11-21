/**
 * 파일 목록 정렬 — 이름·크기·최근 수정, 오름/내림. 순수 함수(app/test 가 node 에서 검사한다).
 *
 * 서버는 이름순으로만 준다. 큰 파일·최근 바뀐 파일을 찾으려면 훑어야 해서 화면에서 다시 늘어놓는다.
 * 폴더는 늘 파일 위에 둔다(파일 화면이 폴더·파일을 따로 그린다). 폴더에는 수정 시각이 없어 「최근」이면 이름순.
 */

export type SortKey = 'name' | 'size' | 'updated';

export interface SortOrder {
  key: SortKey;
  /** 내림차순. 이름은 가나다 거꾸로, 크기는 큰 것부터, 최근은 새것부터. */
  desc: boolean;
}

export const DEFAULT_SORT: SortOrder = { key: 'name', desc: false };

/** 처음 고를 때의 방향 — 크기·최근은 큰 것·새것부터 보고 싶은 경우가 많다. */
export function defaultDescFor(key: SortKey): boolean {
  return key !== 'name';
}

/** 정렬 버튼을 눌렀을 때 — 같은 기준이면 방향만 뒤집고, 다른 기준이면 그 기준의 기본 방향으로. */
export function nextSortOrder(current: SortOrder, key: SortKey): SortOrder {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: defaultDescFor(key) };
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export function sortFiles<T extends { name: string; size: number; updatedAt: number }>(files: T[], order: SortOrder): T[] {
  const sign = order.desc ? -1 : 1;
  return [...files].sort((a, b) => {
    let diff = 0;
    if (order.key === 'size') diff = a.size - b.size;
    else if (order.key === 'updated') diff = a.updatedAt - b.updatedAt;
    else diff = byName(a, b);
    // 같은 크기·같은 시각이면 이름순(방향과 무관)으로 흔들리지 않게.
    return diff !== 0 ? diff * sign : byName(a, b);
  });
}

export function sortDirs<T extends { name: string; totalSize: number }>(dirs: T[], order: SortOrder): T[] {
  const sign = order.desc ? -1 : 1;
  return [...dirs].sort((a, b) => {
    if (order.key === 'size') {
      const diff = a.totalSize - b.totalSize;
      if (diff !== 0) return diff * sign;
      return byName(a, b);
    }
    if (order.key === 'name') return byName(a, b) * sign;
    return byName(a, b);
  });
}

/** 기기에 기억한 값 읽기. 모르는 값이면 기본. */
export function parseSortOrder(raw: string | null | undefined): SortOrder {
  if (!raw) return DEFAULT_SORT;
  const [key, dir] = raw.split(':');
  if (key !== 'name' && key !== 'size' && key !== 'updated') return DEFAULT_SORT;
  return { key, desc: dir === 'desc' };
}

export function serializeSortOrder(order: SortOrder): string {
  return `${order.key}:${order.desc ? 'desc' : 'asc'}`;
}
