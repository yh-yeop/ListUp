import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeMoves, fileMoves, planMoveInto, topLevelOnly } from '../src/lib/move';

const F = (path: string) => ({ path, isFolder: false });
const D = (path: string) => ({ path, isFolder: true });

describe('옮기기 계획', () => {
  it('고른 폴더 안의 것은 빼고 옮긴다', () => {
    assert.deepEqual(topLevelOnly([D('사진'), F('사진/1.jpg'), F('a.txt'), F('a.txt')]).map((i) => i.path), ['사진', 'a.txt']);
  });

  it('폴더 바로 아래로, 이름은 그대로', () => {
    const plan = planMoveInto([F('a.txt'), D('문서/회의')], '보관');
    assert.deepEqual(plan, { ok: true, moves: [{ from: 'a.txt', to: '보관/a.txt' }, { from: '문서/회의', to: '보관/회의' }] });
    const top = planMoveInto([F('보관/a.txt')], '');
    assert.deepEqual(top, { ok: true, moves: [{ from: '보관/a.txt', to: 'a.txt' }] });
  });

  it('이미 그 폴더에 있는 것은 건너뛰고, 모두 그렇다면 알린다', () => {
    const plan = planMoveInto([F('보관/a.txt'), F('b.txt')], '보관');
    assert.deepEqual(plan, { ok: true, moves: [{ from: 'b.txt', to: '보관/b.txt' }] });
    assert.deepEqual(planMoveInto([F('보관/a.txt')], '보관'), { ok: false, reason: '이미 그 폴더에 있습니다.' });
  });

  it('폴더를 자기 안으로, 같은 이름 둘은 안 된다', () => {
    assert.equal(planMoveInto([D('사진')], '사진/여름').ok, false);
    assert.equal(planMoveInto([D('사진')], '사진').ok, false);
    const twins = planMoveInto([F('x/a.txt'), F('y/a.txt')], '');
    assert.equal(twins.ok, false);
  });

  it('제안용으로 파일 단위로 편다', () => {
    const files = ['사진/1.jpg', '사진/여름/2.jpg', '사진첩/3.jpg', 'a.txt'];
    assert.deepEqual(fileMoves([{ from: '사진', to: '보관/사진' }, { from: 'a.txt', to: '보관/a.txt' }], files), [
      { path: '보관/사진/1.jpg', movedFrom: '사진/1.jpg' },
      { path: '보관/사진/여름/2.jpg', movedFrom: '사진/여름/2.jpg' },
      { path: '보관/a.txt', movedFrom: 'a.txt' },
    ]);
  });

  it('한 줄 설명', () => {
    assert.equal(describeMoves([{ from: 'a', to: 'b/a' }]), 'a → b/a');
    assert.equal(describeMoves([{ from: 'a', to: 'b/a' }, { from: 'c', to: 'b/c' }]), '2개 → b/');
    assert.equal(describeMoves([{ from: 'x/a', to: 'a' }, { from: 'x/c', to: 'c' }]), '2개 → (맨 위)');
  });
});
