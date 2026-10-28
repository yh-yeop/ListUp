import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchRepos } from '../src/lib/pure/repo-search';

const repo = (name: string, description = '') => ({ name, description });
const names = (items: { name: string }[]) => items.map((item) => item.name);

const REPOS = [
  repo('동아리 사진첩', '2026 봄 MT'),
  repo('음악', '집 서버 노래 모음'),
  repo('회의록', '동아리 운영 회의'),
  repo('Photos Backup'),
];

describe('searchRepos', () => {
  it('빈 검색어는 목록 그대로', () => {
    assert.equal(searchRepos(REPOS, '   '), REPOS);
  });

  it('이름에서 찾은 것이 설명에서만 찾은 것보다 앞', () => {
    // "동아리" 는 사진첩의 이름, 회의록의 설명에 있다 — 받은 순서와 상관없이 이름 쪽이 먼저.
    const reordered = [REPOS[2], REPOS[0]];
    assert.deepEqual(names(searchRepos(reordered, '동아리')), ['동아리 사진첩', '회의록']);
  });

  it('낱말은 모두 들어 있어야 하고, 이름과 설명에 나뉘어 있어도 된다', () => {
    assert.deepEqual(names(searchRepos(REPOS, '동아리 회의')), ['회의록']);
    assert.deepEqual(names(searchRepos(REPOS, '음악 노래')), ['음악']);
    assert.deepEqual(names(searchRepos(REPOS, '음악 사진')), []);
  });

  it('대소문자와 한글 분해형(NFD)을 가리지 않는다', () => {
    assert.deepEqual(names(searchRepos(REPOS, 'photos')), ['Photos Backup']);
    assert.deepEqual(names(searchRepos(REPOS, '사진'.normalize('NFD'))), ['동아리 사진첩']);
    const nfdRepo = repo('여행 사진'.normalize('NFD'));
    assert.deepEqual(searchRepos([nfdRepo], '여행'), [nfdRepo]);
  });
});
