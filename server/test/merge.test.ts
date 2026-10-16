import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeText, matchLines, merge3, splitLines } from '../src/lib/merge.ts';

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join('');

describe('텍스트 3-way 병합', () => {
  it('줄 끝을 남긴 채 나눈다', () => {
    assert.deepEqual(splitLines('a\r\nb\nc'), ['a\r\n', 'b\n', 'c']);
    assert.deepEqual(splitLines(''), []);
  });

  it('서로 다른 곳을 고쳤으면 둘 다 살린다', () => {
    const base = lines('제목', '첫째', '둘째', '셋째', '끝');
    const theirs = lines('제목', '첫째 (저장소가 고침)', '둘째', '셋째', '끝');
    const mine = lines('제목', '첫째', '둘째', '셋째 (제안이 고침)', '끝', '덧붙임');
    const result = merge3(base, theirs, mine);
    assert.deepEqual(result, { ok: true, text: lines('제목', '첫째 (저장소가 고침)', '둘째', '셋째 (제안이 고침)', '끝', '덧붙임') });
  });

  it('같은 줄을 다르게 고쳤으면 합치지 못한다', () => {
    const base = lines('a', 'b', 'c');
    assert.deepEqual(merge3(base, lines('a', 'B1', 'c'), lines('a', 'B2', 'c')), { ok: false, reason: 'conflict' });
  });

  it('같은 줄을 똑같이 고쳤으면 하나로', () => {
    const base = lines('a', 'b', 'c');
    assert.deepEqual(merge3(base, lines('a', 'X', 'c'), lines('a', 'X', 'c')), { ok: true, text: lines('a', 'X', 'c') });
  });

  it('한쪽만 지우고 다른 쪽이 다른 곳에 더한 것', () => {
    const base = lines('1', '2', '3', '4');
    const theirs = lines('1', '3', '4'); // 2 를 지움
    const mine = lines('1', '2', '3', '4', '5'); // 5 를 더함
    assert.deepEqual(merge3(base, theirs, mine), { ok: true, text: lines('1', '3', '4', '5') });
  });

  it('맨 앞에 서로 다른 것을 더하면 충돌', () => {
    assert.deepEqual(merge3(lines('x'), lines('A', 'x'), lines('B', 'x')), { ok: false, reason: 'conflict' });
  });

  it('LCS 는 앞뒤 공통을 떼고 가운데만 맞춘다', () => {
    assert.deepEqual(matchLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), [0, -1, 2, 3]);
  });

  it('텍스트가 아니면 합치지 않는다', () => {
    assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), null);
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null);
    assert.equal(decodeText(Buffer.from('한글 ok')), '한글 ok');
  });
});
