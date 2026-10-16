import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareFolder, type RepoFile } from '../src/lib/folder-compare';
import type { LocalEntry } from '../src/lib/local-folder';

const repo = (relativePath: string, size = 1): RepoFile =>
  ({ relativePath, path: relativePath, name: relativePath.split('/').pop()!, size }) as RepoFile;
const local = (relativePath: string, size = 1): LocalEntry =>
  ({ relativePath, name: relativePath.split('/').pop()!, size }) as LocalEntry;

describe('내 폴더와 비교', () => {
  it('경로로 견주면 폴더가 다르면 다른 파일이다', () => {
    const result = compareFolder([repo('앨범/a.mp3'), repo('b.mp3')], [local('a.mp3'), local('b.mp3')], false);
    assert.deepEqual(result.both.map((m) => m.key), ['b.mp3']);
    assert.deepEqual(result.repoOnly.map((f) => f.relativePath), ['앨범/a.mp3']);
    assert.deepEqual(result.localOnly.map((f) => f.relativePath), ['a.mp3']);
  });

  it('이름만 견주면 같은 이름을 한데 묶고 그 수를 센다', () => {
    const result = compareFolder([repo('x/a.mp3'), repo('y/a.mp3')], [local('a.mp3')], true);
    assert.equal(result.both.length, 1);
    assert.equal(result.both[0].repo.length, 2);
    assert.equal(result.groupedNames, 1);
  });

  it('분해형 한글(NFD) 이름도 같은 이름으로 본다', () => {
    const nfd = '노래.mp3'.normalize('NFD');
    const result = compareFolder([repo('노래.mp3')], [local(nfd)], false);
    assert.equal(result.both.length, 1);
    assert.equal(result.localOnly.length, 0);
  });

  it('크기가 같은 쌍이 하나도 없을 때만 크기가 다르다고 한다', () => {
    const differs = compareFolder([repo('a', 1)], [local('a', 2)], false);
    assert.equal(differs.both[0].sizeDiffers, true);
    const some = compareFolder([repo('x/a', 1), repo('y/a', 2)], [local('a', 2)], true);
    assert.equal(some.both[0].sizeDiffers, false);
  });

  it('숫자는 숫자 순서로 정렬한다', () => {
    const result = compareFolder([repo('10.txt'), repo('2.txt'), repo('1.txt')], [], false);
    assert.deepEqual(result.repoOnly.map((f) => f.relativePath), ['1.txt', '2.txt', '10.txt']);
  });
});
