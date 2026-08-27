import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { collectGarbage } from '../src/services/gc.ts';
import {
  auth,
  createHarness,
  createRepo,
  signup,
  uploadBlob,
  uploadFile,
  type Harness,
} from './helpers.ts';

let h: Harness;
afterEach(async () => {
  await h.close();
});

/** blob 을 오래된 것으로 만든다 — GC 유예 시간을 기다리지 않고 검사하려고. */
function ageBlobs(harness: Harness, ms: number): void {
  harness.ctx.db.prepare(`UPDATE blobs SET created_at = created_at - ?`).run(ms);
}

const HOUR = 60 * 60 * 1000;

describe('참조되지 않는 blob 정리', () => {
  it('제안에 담기지 않은 업로드는 지우고, 저장소 파일은 남긴다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '저장소');

    await uploadFile(h.app, user, repoId, 'keep.txt', '남을 파일');
    const strayHash = await uploadBlob(h.app, user, repoId, 'stray.txt', '버려질 업로드');

    const keepHash = (
      h.ctx.db
        .prepare<[], { blob_hash: string }>(`SELECT blob_hash FROM snapshot_entries LIMIT 1`)
        .get()!
    ).blob_hash;

    assert.ok(await h.ctx.blobs.has(strayHash));
    ageBlobs(h, 25 * HOUR);

    const result = await collectGarbage(h.ctx, 24 * HOUR);
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    assert.ok(result.freedBytes > 0);

    // 참조 없는 것만 사라진다.
    assert.equal(await h.ctx.blobs.has(strayHash), false);
    assert.ok(await h.ctx.blobs.has(keepHash));
    const rows = h.ctx.db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM blobs`).get()!;
    assert.equal(rows.c, 1);
  });

  it('제안에 담긴 blob 은 지우지 않는다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '저장소');
    await uploadFile(h.app, user, repoId, 'note.txt', '원본');

    const hash = await uploadBlob(h.app, user, repoId, 'note.txt', '고친 내용');
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(user),
      payload: { title: 'fix', changes: [{ path: 'note.txt', blobHash: hash }] },
    });
    assert.equal(created.statusCode, 201);

    ageBlobs(h, 25 * HOUR);
    const result = await collectGarbage(h.ctx, 24 * HOUR);

    assert.equal(result.removed, 0);
    assert.ok(await h.ctx.blobs.has(hash));
  });

  it('유예 시간 안에 올라온 것은 건드리지 않는다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '저장소');
    const hash = await uploadBlob(h.app, user, repoId, 'fresh.txt', '방금 올린 것');

    const result = await collectGarbage(h.ctx, 24 * HOUR);
    assert.equal(result.removed, 0);
    assert.ok(await h.ctx.blobs.has(hash));
  });

  it('저장소를 지우면 그 파일도 회수 대상이 된다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '지울 저장소');
    await uploadFile(h.app, user, repoId, 'gone.txt', '저장소와 함께 사라질 내용');
    const hash = (
      h.ctx.db
        .prepare<[], { blob_hash: string }>(`SELECT blob_hash FROM snapshot_entries LIMIT 1`)
        .get()!
    ).blob_hash;

    const deleted = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}`,
      headers: auth(user),
    });
    assert.equal(deleted.statusCode, 200);

    ageBlobs(h, 25 * HOUR);
    const result = await collectGarbage(h.ctx, 24 * HOUR);
    assert.equal(result.removed, 1);
    assert.equal(await h.ctx.blobs.has(hash), false);
  });

  it('DB 에 없는 고아 파일도 줍는다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '저장소');
    await uploadFile(h.app, user, repoId, 'keep.txt', '남을 파일');

    // 이전 GC 가 파일을 지우기 전에 끊긴 상황: 파일만 있고 blobs 행이 없다.
    const orphanHash = 'a'.repeat(64);
    const orphanPath = h.ctx.blobs.pathFor(orphanHash);
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, '고아');
    const old = Date.now() - 48 * HOUR;
    fs.utimesSync(orphanPath, old / 1000, old / 1000);

    const result = await collectGarbage(h.ctx, 24 * HOUR);
    assert.equal(result.orphanFiles, 1);
    assert.equal(fs.existsSync(orphanPath), false);

    // 정상 파일은 그대로다.
    const kept = h.ctx.db
      .prepare<[], { blob_hash: string }>(`SELECT blob_hash FROM snapshot_entries LIMIT 1`)
      .get()!;
    assert.ok(await h.ctx.blobs.has(kept.blob_hash));
  });
});
