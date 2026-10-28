import type { FileEntry } from '@listup/shared';

export { REPO_SEARCH_MIN, searchRepos } from './pure/repo-search';

/** 검색 결과로 한 번에 그리는 최대 수. 더 있으면 더 좁혀 달라고 한다. */
export const MAX_SEARCH_RESULTS = 200;

const fold = (value: string) => value.normalize('NFC').toLocaleLowerCase();

/**
 * 파일 이름 검색 — 띄어 쓴 낱말이 모두 경로 어딘가에 들어 있으면 찾는다(대소문자·한글 조합형 무시).
 * 파일 이름에서 찾은 것을 폴더 이름에서만 찾은 것보다 앞에 둔다. 그 안에서는 경로 순서.
 */
export function searchFiles<T extends FileEntry>(files: T[], query: string): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const byName: T[] = [];
  const byPath: T[] = [];
  for (const file of files) {
    const path = fold(file.path);
    if (!terms.every((term) => path.includes(term))) continue;
    const name = fold(file.name);
    (terms.every((term) => name.includes(term)) ? byName : byPath).push(file);
  }
  const order = (a: T, b: T) => a.path.localeCompare(b.path, 'ko', { numeric: true });
  return [...byName.sort(order), ...byPath.sort(order)];
}
