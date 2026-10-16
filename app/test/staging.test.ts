import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alreadyStaged, mergeStaged, type StagedChange } from '../src/lib/staging';

const change = (key: string, path: string, blobHash: string | null = `h-${key}`): StagedChange => ({
  key,
  path,
  blobHash,
  size: 1,
  originalName: path,
});

describe('제안에 담기', () => {
  it('이미 담긴 경로를 고른 순서대로 한 번씩 알려준다', () => {
    const staged = [change('1', 'a.txt'), change('2', '폴더/b.txt')];
    assert.deepEqual(alreadyStaged(staged, ['c.txt', '폴더/b.txt', 'a.txt', 'a.txt']), ['폴더/b.txt', 'a.txt']);
    assert.deepEqual(alreadyStaged([], ['a.txt']), []);
  });

  it('같은 경로는 새것으로 바꾸고 자리는 그대로, 새 경로는 뒤에', () => {
    const staged = [change('1', 'a.txt'), change('2', 'b.txt'), change('3', 'c.txt')];
    const merged = mergeStaged(staged, [change('4', 'b.txt'), change('5', 'd.txt')]);
    assert.deepEqual(
      merged.map((c) => c.key),
      ['1', '4', '3', '5'],
    );
  });

  it('삭제 제안을 담아 둔 경로에 파일을 담으면 바꾸기가 된다', () => {
    const merged = mergeStaged([change('del', 'a.txt', null)], [change('up', 'a.txt', 'h1')]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].blobHash, 'h1');
  });
});
