import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planBulkMove } from '../src/lib/pure/bulk-move';

const a = { path: 'a.txt', name: 'a.txt', blobHash: 'ha' };
const b = { path: '사진/b.jpg', name: 'b.jpg', blobHash: 'hb' };

describe('여러 파일 옮기기 계획', () => {
  it('새 경로에 같은 내용 + 옛 경로 삭제, 커밋 하나', () => {
    const plan = planBulkMove([a, b], '보관', ['다른.txt']);
    assert.deepEqual(plan.clashes, []);
    assert.deepEqual(plan.changes, [
      { path: '보관/a.txt', blobHash: 'ha' },
      { path: 'a.txt', blobHash: null },
      { path: '보관/b.jpg', blobHash: 'hb' },
      { path: '사진/b.jpg', blobHash: null },
    ]);
  });

  it('맨 위로 옮기기, 이미 그 폴더에 있는 파일은 건너뛴다', () => {
    const plan = planBulkMove([a, b], '', ['a.txt', '사진']);
    assert.deepEqual(plan.unchanged, ['a.txt']);
    assert.deepEqual(plan.changes, [
      { path: 'b.jpg', blobHash: 'hb' },
      { path: '사진/b.jpg', blobHash: null },
    ]);
  });

  it('옮길 폴더에 같은 이름(파일·폴더)이 있으면 아무것도 옮기지 않는다 — 커밋은 조용히 덮어쓰므로', () => {
    const plan = planBulkMove([a, b], '보관', ['b.jpg']);
    assert.deepEqual(plan.clashes, ['b.jpg']);
    assert.deepEqual(plan.changes, []);
  });

  it('고른 것끼리 이름이 같아도 겹침', () => {
    const plan = planBulkMove([b, { path: '그림/b.jpg', name: 'b.jpg', blobHash: 'hc' }], '보관', []);
    assert.deepEqual(plan.clashes, ['b.jpg']);
  });
});
