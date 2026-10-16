import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cachedHash,
  isSafeToAutoApply,
  needsHash,
  PROPOSED_DELETE,
  planSync,
  resolveConflict,
  type LocalSide,
  type RemoteSide,
  type SyncBase,
} from '../src/lib/sync-plan';

const L = (hash: string | null, size = 1, mtime?: number): LocalSide => ({ hash, size, mtime });
const R = (hash: string, size = 1): RemoteSide => ({ hash, size });
const map = <T>(entries: Record<string, T>) => new Map(Object.entries(entries));
const kinds = (plan: ReturnType<typeof planSync>) =>
  Object.fromEntries(plan.actions.map((a) => [a.path, a.kind === 'conflict' ? `conflict:${a.reason}` : a.kind]));

describe('폴더 동기화 계획 (3-way)', () => {
  const base: SyncBase = {
    'same.txt': { hash: 'h0', size: 1 },
    'mine.txt': { hash: 'h0', size: 1 },
    'theirs.txt': { hash: 'h0', size: 1 },
    'both.txt': { hash: 'h0', size: 1 },
    'both-same.txt': { hash: 'h0', size: 1 },
    'i-deleted.txt': { hash: 'h0', size: 1 },
    'they-deleted.txt': { hash: 'h0', size: 1 },
    'gone.txt': { hash: 'h0', size: 1 },
    'edit-vs-del.txt': { hash: 'h0', size: 1 },
    'del-vs-edit.txt': { hash: 'h0', size: 1 },
  };
  const local = map({
    'same.txt': L('h0'),
    'mine.txt': L('mine'),
    'theirs.txt': L('h0'),
    'both.txt': L('mine'),
    'both-same.txt': L('new'),
    'they-deleted.txt': L('h0'),
    'edit-vs-del.txt': L('mine'),
    'new-local.txt': L(null),
  });
  const remote = map({
    'same.txt': R('h0'),
    'mine.txt': R('h0'),
    'theirs.txt': R('theirs'),
    'both.txt': R('theirs'),
    'both-same.txt': R('new'),
    'i-deleted.txt': R('h0'),
    'del-vs-edit.txt': R('theirs'),
    'new-remote.txt': R('n'),
  });

  it('누가 바꿨는지 가려 할 일을 정한다', () => {
    const plan = planSync(base, local, remote);
    assert.deepEqual(kinds(plan), {
      'both.txt': 'conflict:both-changed',
      'del-vs-edit.txt': 'conflict:deleted-changed',
      'edit-vs-del.txt': 'conflict:changed-deleted',
      'i-deleted.txt': 'delete-remote',
      'mine.txt': 'upload',
      'new-local.txt': 'upload',
      'new-remote.txt': 'download',
      'they-deleted.txt': 'delete-local',
      'theirs.txt': 'download',
    });
  });

  it('양쪽이 같아졌거나 양쪽에서 사라진 것은 기준만 고친다', () => {
    const plan = planSync(base, local, remote);
    assert.deepEqual(
      plan.adopt.map((a) => [a.path, a.entry?.hash ?? null]),
      [
        ['both-same.txt', 'new'],
        ['gone.txt', null],
      ],
    );
  });

  it('처음 맞출 때는 한쪽에만 있는 것은 채우고, 다르면 충돌 — 지우지는 않는다', () => {
    const plan = planSync(null, map({ a: L('x'), b: L('1'), c: L('same') }), map({ b: R('2'), c: R('same'), d: R('y') }));
    assert.deepEqual(kinds(plan), { a: 'upload', b: 'conflict:first-differs', d: 'download' });
    assert.deepEqual(plan.adopt.map((a) => a.path), ['c']);
  });

  it('열람자가 이미 제안한 내용은 다시 올리지 않는다', () => {
    const proposed: SyncBase = { 'a.txt': { hash: 'h0', size: 1, proposedHash: 'mine' } };
    assert.deepEqual(kinds(planSync(proposed, map({ 'a.txt': L('mine') }), map({ 'a.txt': R('h0') }))), { 'a.txt': 'proposed' });
    // 제안한 뒤 또 고쳤으면 다시 올린다.
    assert.deepEqual(kinds(planSync(proposed, map({ 'a.txt': L('mine2') }), map({ 'a.txt': R('h0') }))), { 'a.txt': 'upload' });
    // 제안이 반영되면 양쪽이 같아져 기준을 고친다(제안 표시도 지운다).
    const merged = planSync(proposed, map({ 'a.txt': L('mine') }), map({ 'a.txt': R('mine') }));
    assert.equal(merged.actions.length, 0);
    assert.deepEqual(merged.adopt[0].entry, { hash: 'mine', size: 1, mtime: undefined });
  });

  it('열람자가 제안해 둔 새 파일·지우기도 다시 제안하지 않는다', () => {
    const proposedNew: SyncBase = { 'new.txt': { hash: '', size: 0, proposedHash: 'n1' } };
    assert.deepEqual(kinds(planSync(proposedNew, map({ 'new.txt': L('n1') }), new Map())), { 'new.txt': 'proposed' });
    const proposedDelete: SyncBase = { 'old.txt': { hash: 'h0', size: 1, proposedHash: PROPOSED_DELETE } };
    assert.deepEqual(kinds(planSync(proposedDelete, new Map(), map({ 'old.txt': R('h0') }))), { 'old.txt': 'proposed' });
    // 기준이 있는데 그 경로만 기준에 없으면 처음 맞추기가 아니라 보통 규칙 — 양쪽에 새로 생겨 다르면 충돌.
    assert.deepEqual(kinds(planSync({}, map({ x: L('a') }), map({ x: R('b') }))), { x: 'conflict:both-changed' });
  });

  it('충돌은 고른 쪽을 따른다', () => {
    const conflict = { kind: 'conflict' as const, path: 'x', reason: 'both-changed' as const };
    assert.deepEqual(resolveConflict(conflict, 'mine', { local: true, remote: true }), { kind: 'upload', path: 'x' });
    assert.deepEqual(resolveConflict(conflict, 'theirs', { local: true, remote: true }), { kind: 'download', path: 'x' });
    assert.deepEqual(resolveConflict(conflict, 'mine', { local: false, remote: true }), { kind: 'delete-remote', path: 'x' });
    assert.deepEqual(resolveConflict(conflict, 'theirs', { local: true, remote: false }), { kind: 'delete-local', path: 'x' });
  });

  it('크기·고친 시각이 기준과 같으면 다시 읽지 않는다', () => {
    const b: SyncBase = { a: { hash: 'h', size: 5, mtime: 100 } };
    const remote = map({ c: R('x', 3) });
    assert.equal(needsHash('a', { size: 5, mtime: 100 }, b, remote), false);
    assert.equal(cachedHash('a', { size: 5, mtime: 100 }, b), 'h');
    assert.equal(needsHash('a', { size: 5, mtime: 200 }, b, remote), true);
    assert.equal(needsHash('b', { size: 9 }, b, remote), false, '기준에도 저장소에도 없는 새 파일은 몰라도 된다');
    assert.equal(needsHash('c', { size: 3 }, b, remote), true, '저장소에 같은 크기가 있으면 같은 내용인지 본다');
    assert.equal(needsHash('c', { size: 4 }, b, remote), false);
  });

  it('지우기나 충돌이 있으면 자동으로 하지 않는다', () => {
    assert.equal(isSafeToAutoApply(planSync(null, map({ a: L('x') }), new Map())), true);
    assert.equal(isSafeToAutoApply(planSync(base, local, remote)), false);
  });
});
