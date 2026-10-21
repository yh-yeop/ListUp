import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remoteFilesOf, splitUnchanged, type UploadItem } from '../src/lib/pure/transfer-plan';

/** 저장소에 올라간 때. */
const UPLOADED_AT = 1_700_000_000_000;

function webItem(path: string, size: number, lastModified?: number): UploadItem {
  const name = path.slice(path.lastIndexOf('/') + 1);
  // 판정은 크기·고친 시각만 본다 — File 자체는 쓰지 않는다.
  return { path, source: { kind: 'web', file: {} as File, name, size, lastModified } };
}

const remote = (...files: [path: string, size: number][]) =>
  remoteFilesOf(files.map(([path, size]) => ({ path, size, updatedAt: UPLOADED_AT })));

const paths = (items: UploadItem[]) => items.map((item) => item.path);

describe('splitUnchanged', () => {
  it('같은 경로·같은 크기이고 올린 뒤 고치지 않았으면 건너뛴다', () => {
    const { changed, unchanged } = splitUnchanged(
      [webItem('앨범/a.mp3', 100, UPLOADED_AT - 1), webItem('앨범/b.mp3', 200, UPLOADED_AT)],
      remote(['앨범/a.mp3', 100], ['앨범/b.mp3', 200]),
    );
    assert.deepEqual(paths(changed), []);
    assert.deepEqual(paths(unchanged), ['앨범/a.mp3', '앨범/b.mp3']);
  });

  it('고친 시각이 같아도 크기가 다르면 다시 올린다', () => {
    const { changed, unchanged } = splitUnchanged([webItem('a.mp3', 101, UPLOADED_AT - 1)], remote(['a.mp3', 100]));
    assert.deepEqual(paths(changed), ['a.mp3']);
    assert.deepEqual(paths(unchanged), []);
  });

  it('크기가 같아도 올린 뒤에 고쳤으면 다시 올린다 (태그만 고친 mp3)', () => {
    const { changed } = splitUnchanged([webItem('a.mp3', 100, UPLOADED_AT + 1)], remote(['a.mp3', 100]));
    assert.deepEqual(paths(changed), ['a.mp3']);
  });

  it('고친 시각을 모르면(없음·0·PC 앱 폴더) 늘 올린다', () => {
    const desktop: UploadItem = {
      path: 'c.mp3',
      source: { kind: 'desktop', root: 'root', relativePath: 'c.mp3', name: 'c.mp3', size: 100 },
    };
    const { changed, unchanged } = splitUnchanged(
      [webItem('a.mp3', 100), webItem('b.mp3', 100, 0), desktop],
      remote(['a.mp3', 100], ['b.mp3', 100], ['c.mp3', 100]),
    );
    assert.deepEqual(paths(changed), ['a.mp3', 'b.mp3', 'c.mp3']);
    assert.deepEqual(paths(unchanged), []);
  });

  it('저장소에 없는 경로는 올린다 — 다른 폴더의 같은 이름도', () => {
    const { changed } = splitUnchanged(
      [webItem('새.mp3', 100, 1), webItem('다른/a.mp3', 100, 1)],
      remote(['a.mp3', 100]),
    );
    assert.deepEqual(paths(changed), ['새.mp3', '다른/a.mp3']);
  });

  it('경로를 NFC 로 맞춰 견준다 — 분해형(NFD) 한글·악센트 이름도 같은 파일', () => {
    const nfc = '노래/café.mp3'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    // 기기가 분해형으로 주고 저장소는 조합형
    assert.deepEqual(paths(splitUnchanged([webItem(nfd, 100, 1)], remote([nfc, 100])).unchanged), [nfd]);
    // 저장소 쪽이 분해형이어도 remoteFilesOf 가 맞춘다
    assert.deepEqual(paths(splitUnchanged([webItem(nfc, 100, 1)], remote([nfd, 100])).unchanged), [nfc]);
  });

  it('나눈 뒤에도 원래 순서를 지킨다', () => {
    const items = [webItem('1', 1, 1), webItem('2', 2, 1), webItem('3', 3, 1), webItem('4', 4, 1)];
    const { changed, unchanged } = splitUnchanged(items, remote(['2', 2], ['4', 4]));
    assert.deepEqual(paths(changed), ['1', '3']);
    assert.deepEqual(paths(unchanged), ['2', '4']);
  });
});
