import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareFolder, contentFindings, hashCandidates, type RepoFile } from '../src/lib/folder-compare';
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

describe('내 폴더와 비교 — 내용으로', () => {
  const repoH = (relativePath: string, hash: string, size = 1): RepoFile =>
    ({ relativePath, path: relativePath, name: relativePath.split('/').pop()!, size, blobHash: hash }) as RepoFile;

  it('크기가 같은 짝과, 같은 크기가 저장소에 있는 내 파일만 해시를 계산한다', () => {
    const repoFiles = [repoH('a.txt', 'h1', 5), repoH('b.txt', 'h2', 9), repoH('old/c.txt', 'h3', 7)];
    const result = compareFolder(repoFiles, [local('a.txt', 5), local('b.txt', 1), local('new/c.txt', 7), local('d.txt', 100)], false);
    assert.deepEqual(
      hashCandidates(result, repoFiles).map((e) => e.relativePath).sort(),
      ['a.txt', 'new/c.txt'],
    );
  });

  it('이름이 같은 짝을 같음/다름으로 나누고, 옮긴 파일과 이미 있는 내용을 찾는다', () => {
    const repoFiles = [
      repoH('a.txt', 'same', 5),
      repoH('b.txt', 'theirs', 5),
      repoH('old/c.txt', 'moved', 7),
      repoH('d.txt', 'dup', 3), // 내 폴더에도 같은 경로로 있다 — e.txt 는 "이미 있음"이지 옮긴 것이 아니다
    ];
    const locals = [local('a.txt', 5), local('b.txt', 5), local('new/c.txt', 7), local('또다른/e.txt', 3), local('d.txt', 3)];
    const result = compareFolder(repoFiles, locals, false);
    const hashes = new Map([
      ['a.txt', 'same'],
      ['b.txt', 'mine'],
      ['new/c.txt', 'moved'],
      ['또다른/e.txt', 'dup'],
      ['d.txt', 'dup'],
    ]);
    const findings = contentFindings(result, hashes, repoFiles);
    assert.deepEqual([...findings.identical].sort(), ['a.txt', 'd.txt']);
    assert.deepEqual([...findings.differs], ['b.txt']);
    assert.deepEqual(findings.moved.map((m) => [m.local.relativePath, m.repo.relativePath]), [['new/c.txt', 'old/c.txt']]);
    assert.deepEqual(findings.alreadyInRepo.map((m) => m.local.relativePath), ['또다른/e.txt']);
  });

  it('해시를 아직 모르는 짝은 어느 쪽에도 넣지 않는다', () => {
    const repoFiles = [repoH('a.txt', 'h', 5)];
    const result = compareFolder(repoFiles, [local('a.txt', 5)], false);
    const findings = contentFindings(result, new Map(), repoFiles);
    assert.equal(findings.identical.size + findings.differs.size, 0);
  });
});
