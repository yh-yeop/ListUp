import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearPendingInvite,
  isUnusableInviteStatus,
  markPendingInviteSeen,
  peekPendingInvite,
  setPendingInvite,
  shouldAutoJoin,
} from '../src/lib/pure/pending-invite';

const A = 'https://a.example';
const B = 'https://b.example';

describe('들고 가는 초대 코드', () => {
  beforeEach(() => clearPendingInvite());

  it('그 초대를 낸 서버에서만 꺼낸다', () => {
    setPendingInvite('ABCDE12345', A);
    assert.equal(peekPendingInvite(A), 'ABCDE12345');
    // 로그인 화면에서 다른 서버로 바꿔 로그인했다 — 그 서버에 코드를 조회하지 않는다.
    assert.equal(peekPendingInvite(B), null);
    assert.equal(peekPendingInvite(null), null);
  });

  it('같은 오리진 웹(빈 주소)도 같은 값끼리는 꺼낸다', () => {
    setPendingInvite('ABCDE12345', '');
    assert.equal(peekPendingInvite(''), 'ABCDE12345');
    assert.equal(peekPendingInvite(A), null);
  });

  it('미리보기를 본 것은 같은 코드·서버를 다시 들 때 남고, 다른 코드면 처음으로', () => {
    setPendingInvite('ABCDE12345', A);
    markPendingInviteSeen('ABCDE12345');
    assert.equal(shouldAutoJoin('ABCDE12345'), true);
    setPendingInvite('ABCDE12345', A); // 화면이 다시 그려지며 같은 것을 또 든다
    assert.equal(shouldAutoJoin('ABCDE12345'), true);
    setPendingInvite('FGHJK67890', A);
    assert.equal(shouldAutoJoin('FGHJK67890'), false);
    assert.equal(shouldAutoJoin('ABCDE12345'), false);
  });

  it('지우면 아무 서버에서도 꺼내지 않는다', () => {
    setPendingInvite('ABCDE12345', A);
    clearPendingInvite();
    assert.equal(peekPendingInvite(A), null);
    assert.equal(shouldAutoJoin('ABCDE12345'), false);
  });
});

describe('isUnusableInviteStatus', () => {
  it('형식·없음·회수/만료/소진은 더 못 쓴다', () => {
    for (const status of [400, 404, 409]) assert.equal(isUnusableInviteStatus(status), true, String(status));
  });
  it('연결 실패·옛 서버·잠시 막힘은 다시 해 볼 수 있다', () => {
    for (const status of [0, 401, 429, 500]) assert.equal(isUnusableInviteStatus(status), false, String(status));
  });
});
