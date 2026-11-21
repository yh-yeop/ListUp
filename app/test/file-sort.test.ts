import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SORT,
  nextSortOrder,
  parseSortOrder,
  serializeSortOrder,
  sortDirs,
  sortFiles,
} from '../src/lib/pure/file-sort';

const files = [
  { name: '파일10.txt', size: 5, updatedAt: 300 },
  { name: '파일2.txt', size: 50, updatedAt: 100 },
  { name: 'b.txt', size: 50, updatedAt: 200 },
  { name: 'A.txt', size: 1, updatedAt: 400 },
];
const names = (list: { name: string }[]) => list.map((f) => f.name);

describe('파일 정렬', () => {
  it('이름순 — 숫자는 숫자로(2 < 10), 대소문자 무관, 한글이 먼저(서버와 같은 ko 정렬), 거꾸로도', () => {
    assert.deepEqual(names(sortFiles(files, DEFAULT_SORT)), ['파일2.txt', '파일10.txt', 'A.txt', 'b.txt']);
    assert.deepEqual(names(sortFiles(files, { key: 'name', desc: true })), ['b.txt', 'A.txt', '파일10.txt', '파일2.txt']);
  });

  it('크기순 — 같은 크기는 이름순으로 고정(방향과 무관)', () => {
    assert.deepEqual(names(sortFiles(files, { key: 'size', desc: true })), ['파일2.txt', 'b.txt', '파일10.txt', 'A.txt']);
    assert.deepEqual(names(sortFiles(files, { key: 'size', desc: false })), ['A.txt', '파일10.txt', '파일2.txt', 'b.txt']);
  });

  it('최근 수정순', () => {
    assert.deepEqual(names(sortFiles(files, { key: 'updated', desc: true })), ['A.txt', '파일10.txt', 'b.txt', '파일2.txt']);
  });

  it('원래 배열은 그대로 둔다', () => {
    const copy = [...files];
    sortFiles(files, { key: 'size', desc: true });
    assert.deepEqual(files, copy);
  });

  it('폴더 — 크기는 총용량, 최근은 시각이 없어 이름순', () => {
    const dirs = [
      { name: '사진', totalSize: 10 },
      { name: '문서', totalSize: 99 },
      { name: '음악', totalSize: 10 },
    ];
    assert.deepEqual(names(sortDirs(dirs, { key: 'size', desc: true })), ['문서', '사진', '음악']);
    assert.deepEqual(names(sortDirs(dirs, { key: 'updated', desc: true })), ['문서', '사진', '음악']);
    assert.deepEqual(names(sortDirs(dirs, { key: 'name', desc: true })), ['음악', '사진', '문서']);
  });
});

describe('정렬 기준 바꾸기·기억', () => {
  it('같은 기준을 다시 누르면 방향만, 다른 기준은 그 기준의 기본 방향', () => {
    assert.deepEqual(nextSortOrder(DEFAULT_SORT, 'name'), { key: 'name', desc: true });
    assert.deepEqual(nextSortOrder(DEFAULT_SORT, 'size'), { key: 'size', desc: true });
    assert.deepEqual(nextSortOrder({ key: 'size', desc: true }, 'updated'), { key: 'updated', desc: true });
    assert.deepEqual(nextSortOrder({ key: 'size', desc: true }, 'name'), { key: 'name', desc: false });
  });

  it('저장 형식을 오간다, 모르는 값은 기본', () => {
    for (const order of [DEFAULT_SORT, { key: 'size', desc: true } as const, { key: 'updated', desc: false } as const]) {
      assert.deepEqual(parseSortOrder(serializeSortOrder(order)), order);
    }
    assert.deepEqual(parseSortOrder(null), DEFAULT_SORT);
    assert.deepEqual(parseSortOrder('color:asc'), DEFAULT_SORT);
  });
});
