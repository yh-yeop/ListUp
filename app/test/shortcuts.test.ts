import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SHORTCUTS, matchShortcut, parentPath } from '../src/lib/pure/shortcuts';

describe('키보드 단축키', () => {
  it('키 → 동작', () => {
    assert.equal(matchShortcut({ key: '/' }), 'focus-search');
    assert.equal(matchShortcut({ key: 'Backspace' }), 'folder-up');
    assert.equal(matchShortcut({ key: 'ArrowUp', altKey: true }), 'folder-up');
    assert.equal(matchShortcut({ key: 'Escape' }), 'escape');
    assert.equal(matchShortcut({ key: '?' }), 'help');
    assert.equal(matchShortcut({ key: 'r' }), 'refresh');
    assert.equal(matchShortcut({ key: 'x' }), null);
    assert.equal(matchShortcut({ key: 'ArrowUp' }), null, 'Alt 없는 화살표는 스크롤에 둔다');
  });

  it('한글 입력 상태의 R(ㄱ)도 새로고침 — 자판 위치로', () => {
    assert.equal(matchShortcut({ key: 'ㄱ', code: 'KeyR' }), 'refresh');
    assert.equal(matchShortcut({ key: 'ㄱ', code: 'KeyR', editing: true }), null);
    assert.equal(matchShortcut({ key: 'ㅅ', code: 'KeyT' }), null);
  });

  it('글을 쓰는 중에는 Esc 만', () => {
    assert.equal(matchShortcut({ key: '/', editing: true }), null);
    assert.equal(matchShortcut({ key: 'Backspace', editing: true }), null, '칸에서 지우기가 폴더 이동이 되면 안 된다');
    assert.equal(matchShortcut({ key: 'r', editing: true }), null);
    assert.equal(matchShortcut({ key: 'Escape', editing: true }), 'escape');
  });

  it('Ctrl·⌘ 이 섞이면 브라우저 단축키라 건드리지 않는다', () => {
    assert.equal(matchShortcut({ key: 'r', ctrlKey: true }), null);
    assert.equal(matchShortcut({ key: 'r', metaKey: true }), null);
    assert.equal(matchShortcut({ key: 'Escape', ctrlKey: true }), null);
  });

  it('도움말 목록의 동작은 모두 키로 닿는다', () => {
    const reachable = new Set(['/', 'Backspace', 'Escape', '?', 'r'].map((key) => matchShortcut({ key })));
    for (const shortcut of SHORTCUTS) assert.ok(reachable.has(shortcut.action), shortcut.action);
  });

  it('위 폴더', () => {
    assert.equal(parentPath(''), null);
    assert.equal(parentPath('사진'), '');
    assert.equal(parentPath('사진/2024/여름'), '사진/2024');
  });
});
