import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareFolder, type RepoFile } from '../src/lib/pure/compare-core';
import type { LocalEntry } from '../src/lib/local-folder';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// 대조는 이름·경로·크기만 본다 — 나머지 필드는 비워 둔다.
const repoFile = (relativePath: string, size: number) =>
  ({ path: `저장소/${relativePath}`, relativePath, name: baseName(relativePath), size }) as RepoFile;
const localFile = (relativePath: string, size: number) =>
  ({ relativePath, name: baseName(relativePath), size }) as LocalEntry;

const keys = (items: { relativePath: string }[]) => items.map((item) => item.relativePath);

describe('compareFolder — 경로로', () => {
  it('같은 경로는 양쪽에, 나머지는 한쪽에만', () => {
    const result = compareFolder(
      [repoFile('앨범/a.mp3', 1), repoFile('앨범/b.mp3', 2)],
      [localFile('앨범/a.mp3', 1), localFile('c.mp3', 3)],
      false,
    );
    assert.deepEqual(result.both.map((match) => match.key), ['앨범/a.mp3']);
    assert.deepEqual(keys(result.repoOnly), ['앨범/b.mp3']);
    assert.deepEqual(keys(result.localOnly), ['c.mp3']);
    assert.equal(result.groupedNames, 0);
  });

  it('다른 폴더의 같은 이름은 다른 파일', () => {
    const result = compareFolder([repoFile('A/노래.mp3', 1)], [localFile('B/노래.mp3', 1)], false);
    assert.equal(result.both.length, 0);
    assert.deepEqual(keys(result.repoOnly), ['A/노래.mp3']);
    assert.deepEqual(keys(result.localOnly), ['B/노래.mp3']);
  });

  it('NFC/NFD 를 맞춰 견준다 — 분해형 이름도 양쪽에 있는 것으로, 한쪽에만 있다고 하지 않는다', () => {
    const nfc = '앨범/Beyoncé - 노래.mp3'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    for (const [repoName, localName] of [
      [nfc, nfd],
      [nfd, nfc],
    ]) {
      const result = compareFolder([repoFile(repoName, 5)], [localFile(localName, 5)], false);
      assert.equal(result.both.length, 1);
      assert.equal(result.both[0].key, nfc);
      assert.equal(result.both[0].sizeDiffers, false);
      assert.deepEqual(result.repoOnly, []);
      assert.deepEqual(result.localOnly, []);
    }
  });

  it('대소문자는 구분한다', () => {
    const result = compareFolder([repoFile('A.mp3', 1)], [localFile('a.mp3', 1)], false);
    assert.equal(result.both.length, 0);
  });

  it('크기가 다르면 sizeDiffers', () => {
    const result = compareFolder([repoFile('a.mp3', 1), repoFile('b.mp3', 2)], [localFile('a.mp3', 1), localFile('b.mp3', 3)], false);
    assert.deepEqual(
      result.both.map((match) => [match.key, match.sizeDiffers]),
      [
        ['a.mp3', false],
        ['b.mp3', true],
      ],
    );
  });

  it('숫자를 숫자로 정렬한다 (2 다음 10)', () => {
    const result = compareFolder([repoFile('10.mp3', 1), repoFile('2.mp3', 1)], [localFile('10 x.mp3', 1), localFile('2 x.mp3', 1)], false);
    assert.deepEqual(keys(result.repoOnly), ['2.mp3', '10.mp3']);
    assert.deepEqual(keys(result.localOnly), ['2 x.mp3', '10 x.mp3']);
  });
});

describe('compareFolder — 이름만', () => {
  it('폴더가 달라도 이름이 같으면 같은 파일', () => {
    const result = compareFolder([repoFile('A/노래.mp3', 1)], [localFile('B/C/노래.mp3', 1)], true);
    assert.deepEqual(result.both.map((match) => match.key), ['노래.mp3']);
    assert.deepEqual(result.repoOnly, []);
    assert.deepEqual(result.localOnly, []);
    assert.equal(result.groupedNames, 0);
  });

  it('같은 이름이 여러 곳이면 한데 묶어 센다 — 크기가 같은 쌍이 하나라도 있으면 sizeDiffers 아님', () => {
    const result = compareFolder(
      [repoFile('A/노래.mp3', 1), repoFile('B/노래.mp3', 2), repoFile('x.mp3', 9)],
      [localFile('노래.mp3', 2), localFile('x.mp3', 8), localFile('y/x.mp3', 7)],
      true,
    );
    assert.equal(result.groupedNames, 2);
    const byKey = Object.fromEntries(result.both.map((match) => [match.key, match]));
    assert.equal(byKey['노래.mp3'].repo.length, 2);
    assert.equal(byKey['노래.mp3'].sizeDiffers, false);
    assert.equal(byKey['x.mp3'].local.length, 2);
    assert.equal(byKey['x.mp3'].sizeDiffers, true);
  });

  it('이름도 NFC 로 맞춘다', () => {
    const name = '카페.mp3';
    const result = compareFolder([repoFile(`A/${name.normalize('NFC')}`, 1)], [localFile(`B/${name.normalize('NFD')}`, 1)], true);
    assert.equal(result.both.length, 1);
    assert.deepEqual(result.localOnly, []);
  });
});
