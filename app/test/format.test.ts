import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDate, formatRelativeTime, formatTime } from '@listup/shared';

describe('날짜 표시', () => {
  const at = new Date(2026, 9, 3, 7, 5).getTime(); // 2026-10-03 07:05 (이 기기 시간대)

  it('날짜는 YYYY.MM.DD, 시각은 24시간 HH:mm', () => {
    assert.equal(formatDate(at), '2026.10.03');
    assert.equal(formatTime(at), '07:05');
  });

  it('30일이 넘으면 상대 시간 대신 같은 날짜 모양', () => {
    const later = at + 40 * 24 * 60 * 60 * 1000;
    assert.equal(formatRelativeTime(at, later), formatDate(at));
    assert.equal(formatRelativeTime(at, at + 90 * 60 * 1000), '1시간 전');
  });
});
