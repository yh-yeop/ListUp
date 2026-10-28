/** 이 수 이상이면 저장소 목록 위에 검색 칸을 보인다 — 몇 개뿐일 때는 눈으로 찾는 편이 빠르다. */
export const REPO_SEARCH_MIN = 5;

const fold = (value: string) => value.normalize('NFC').toLocaleLowerCase();

/**
 * 저장소 목록 검색 — 띄어 쓴 낱말이 모두 이름이나 설명에 들어 있으면 찾는다(대소문자·한글 조합형 무시).
 * 이름에서 다 찾은 것을 설명까지 봐야 찾은 것보다 앞에 둔다. 그 안에서는 받은 순서(서버의 최근 순) 그대로.
 * 빈 검색어면 목록 그대로.
 */
export function searchRepos<T extends { name: string; description: string }>(repos: T[], query: string): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return repos;
  const byName: T[] = [];
  const byDescription: T[] = [];
  for (const repo of repos) {
    const name = fold(repo.name);
    if (terms.every((term) => name.includes(term))) {
      byName.push(repo);
      continue;
    }
    const text = `${name}\n${fold(repo.description)}`;
    if (terms.every((term) => text.includes(term))) byDescription.push(repo);
  }
  return [...byName, ...byDescription];
}
