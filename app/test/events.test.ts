import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepoEvent } from '@listup/shared';
import { describeEvent } from '../src/lib/pure/events';

const event = (patch: Partial<RepoEvent>): RepoEvent => ({
  seq: 1,
  kind: 'repo_created',
  actor: { id: 'u1', displayName: '주인' },
  target: null,
  role: null,
  createdAt: 0,
  ...patch,
});

describe('describeEvent', () => {
  it('누가 누구에게 무엇을 했는지 문장으로', () => {
    assert.equal(
      describeEvent(event({ kind: 'member_removed', target: { id: 'u2', displayName: '나' } })).text,
      '주인 님이 나 님을 내보냈습니다',
    );
    assert.equal(
      describeEvent(event({ kind: 'role_changed', target: { id: 'u2', displayName: '가' }, role: 'editor' })).text,
      '주인 님이 가 님을 편집 권한으로 바꿨습니다',
    );
    assert.equal(
      describeEvent(event({ kind: 'member_joined', actor: { id: 'u3', displayName: '다' }, role: 'viewer' })).text,
      '다 님이 초대로 참여했습니다 (열람)',
    );
  });

  it('사람을 모르면 "알 수 없는 사람"', () => {
    assert.equal(describeEvent(event({ kind: 'member_left', actor: null })).text, '알 수 없는 사람 님이 나갔습니다');
  });

  it('이 앱이 모르는 종류는 목록을 깨지 않고 "알 수 없는 활동"', () => {
    const line = describeEvent(event({ kind: 'repo_archived' }));
    assert.equal(line.text, '알 수 없는 활동');
    assert.equal(line.icon, 'help-circle-outline');
  });
});
