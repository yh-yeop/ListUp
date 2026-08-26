import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Snapshot } from '@listup/shared';
import {
  auth,
  createHarness,
  createRepo,
  signup,
  uploadFile,
  type Harness,
  type Session,
} from './helpers.ts';

type Cursor = { before: number; beforeId: string } | null;

describe('변경 이력 커서', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '이력 검사');
    for (const n of [1, 2, 3]) {
      const res = await uploadFile(h.app, owner, repoId, `파일${n}.txt`, `내용 ${n}`);
      assert.equal(res.statusCode, 201);
    }
    // 세 스냅샷이 같은 밀리초에 만들어진 상황을 만든다.
    h.ctx.db.prepare(`UPDATE snapshots SET created_at = ? WHERE repo_id = ?`).run(1_700_000_000_000, repoId);
  });
  after(async () => {
    await h.close();
  });

  async function page(limit: number, cursor: Cursor) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      params.set('before', String(cursor.before));
      params.set('beforeId', cursor.beforeId);
    }
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/history?${params.toString()}`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { snapshots: Snapshot[]; next: Cursor; nextBefore?: unknown };
  }

  it('같은 밀리초의 스냅샷도 건너뛰지 않고 모두 따라간다', async () => {
    const ids: string[] = [];
    let cursor: Cursor = null;
    let requests = 0;
    do {
      const body = await page(1, cursor);
      assert.ok(body.snapshots.length <= 1);
      ids.push(...body.snapshots.map((s) => s.id));
      cursor = body.next;
      requests += 1;
    } while (cursor && requests < 10);

    assert.equal(cursor, null);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    // (created_at, id) 내림차순이므로 id 도 내림차순으로 나온다.
    assert.deepEqual(ids, [...ids].sort().reverse());
  });

  it('커서 없이 부르면 최신 순으로 전부 오고 next 는 null 이다', async () => {
    const body = await page(30, null);
    assert.equal(body.snapshots.length, 3);
    assert.equal(body.next, null);
    assert.equal('nextBefore' in body, false);
  });

  it('결과가 limit 개면 마지막 항목 기준 커서를 준다', async () => {
    const body = await page(2, null);
    assert.equal(body.snapshots.length, 2);
    assert.deepEqual(body.next, {
      before: body.snapshots[1].createdAt,
      beforeId: body.snapshots[1].id,
    });
  });
});
