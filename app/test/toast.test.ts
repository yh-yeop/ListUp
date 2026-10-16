import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { dismissToast, showToast, subscribeToasts, type Toast } from '../src/lib/toast';

let current: Toast[] = [];
let unsubscribe = () => {};

beforeEach(() => {
  unsubscribe();
  for (const toast of current) dismissToast(toast.id);
  unsubscribe = subscribeToasts((toasts) => {
    current = toasts;
  });
});

describe('토스트', () => {
  it('구독하면 지금 목록을 바로 받고, 띄우고 닫는 대로 바뀐다', () => {
    const id = showToast('복사했습니다.');
    assert.deepEqual(current.map((t) => t.title), ['복사했습니다.']);
    dismissToast(id);
    assert.equal(current.length, 0);
  });

  it('같은 안내를 이어서 띄우면 하나만 남는다', () => {
    showToast('저장했습니다.', '설명');
    showToast('저장했습니다.', '설명');
    showToast('저장했습니다.', '다른 설명');
    assert.equal(current.length, 2);
  });

  it('세 개까지만 보이고 오래된 것부터 내린다', () => {
    for (const n of [1, 2, 3, 4]) showToast(`안내 ${n}`);
    assert.deepEqual(current.map((t) => t.title), ['안내 2', '안내 3', '안내 4']);
  });

  it('오류는 더 오래, 긴 글도 더 오래 — 하지만 12초를 넘지 않는다', () => {
    showToast('짧음');
    showToast('짧은 오류', undefined, 'error');
    showToast('길다', 'ㄱ'.repeat(1000));
    const [info, error, long] = current;
    assert.ok(error.durationMs > info.durationMs);
    assert.equal(long.durationMs, 12000);
  });

  it('빈 설명은 없는 것으로 본다', () => {
    showToast('제목', '');
    assert.equal(current[0].message, undefined);
  });
});
