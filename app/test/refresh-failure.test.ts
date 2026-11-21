import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keepDataOnRefreshFailure } from '../src/lib/pure/refresh-failure';

const base = { mode: 'refresh' as const, hasData: true, showingError: false };

describe('새로고침 실패 — 받아 둔 목록 지키기 (U2-12)', () => {
  it('연결 문제·서버 일시 오류면 목록을 그대로 둔다', () => {
    assert.equal(keepDataOnRefreshFailure({ ...base, status: 0 }), true);
    assert.equal(keepDataOnRefreshFailure({ ...base, status: 502 }), true);
    assert.equal(keepDataOnRefreshFailure({ ...base, status: undefined }), true);
  });

  it('더는 볼 수 없다는 답(403·404)이면 오류로 바꾼다 — 옛 목록은 거짓이 된다', () => {
    assert.equal(keepDataOnRefreshFailure({ ...base, status: 403 }), false);
    assert.equal(keepDataOnRefreshFailure({ ...base, status: 404 }), false);
  });

  it('처음 불러오기·목록 없음·이미 오류를 보이는 중이면 늘 오류 자리', () => {
    assert.equal(keepDataOnRefreshFailure({ ...base, mode: 'initial', status: 0 }), false);
    assert.equal(keepDataOnRefreshFailure({ ...base, hasData: false, status: 0 }), false);
    assert.equal(keepDataOnRefreshFailure({ ...base, showingError: true, status: 0 }), false);
  });
});
