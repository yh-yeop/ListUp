import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { collectGarbage } from '../src/services/gc.ts';
import { pruneRepoHistory } from '../src/services/history.ts';
import { readManifest } from '../src/services/snapshots.ts';
import { auth, createHarness, createRepo, signup, uploadFile, type Harness, type Session } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('되돌리기', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '되돌리기');
  });
  after(async () => {
    await h.close();
  });

  const restore = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/restore`, headers: auth(owner), payload });
  const raw = async (path: string) =>
    (await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=${encodeURIComponent(path)}`, headers: auth(owner) }))
      .body;
  const head = () => (h.ctx.db.prepare('SELECT head_snapshot_id AS id FROM repos WHERE id = ?').get(repoId) as { id: string }).id;

  it('저장소 전체를 과거 시점으로 — 새 스냅샷으로 남는다', async () => {
    await uploadFile(h.app, owner, repoId, '문서/a.txt', '첫 내용');
    await uploadFile(h.app, owner, repoId, '사진/b.jpg', 'B');
    const point = head();
    await uploadFile(h.app, owner, repoId, '문서/a.txt', '덮어쓴 내용');
    await uploadFile(h.app, owner, repoId, '새파일.txt', '나중에 생김');
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/files?path=${encodeURIComponent('사진/b.jpg')}`, headers: auth(owner) });

    const res = await restore({ snapshotId: point });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual({ added: res.json().added, updated: res.json().updated, deleted: res.json().deleted }, { added: 1, updated: 1, deleted: 1 });
    assert.equal(await raw('문서/a.txt'), '첫 내용');
    assert.equal(await raw('사진/b.jpg'), 'B');
    assert.equal([...readManifest(h.ctx.db, head()).keys()].sort().join(), '문서/a.txt,사진/b.jpg');
    const message = (h.ctx.db.prepare('SELECT message FROM snapshots WHERE id = ?').get(head()) as { message: string }).message;
    assert.match(message, /^되돌리기: 저장소 전체/);

    const again = await restore({ snapshotId: point });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().unchanged, true);
  });

  it('폴더 하나만 — 범위 밖은 그대로', async () => {
    const point = head();
    await uploadFile(h.app, owner, repoId, '문서/a.txt', '또 바뀜');
    await uploadFile(h.app, owner, repoId, '문서/c.txt', '새 문서');
    await uploadFile(h.app, owner, repoId, '사진/b.jpg', '사진도 바뀜');

    const res = await restore({ snapshotId: point, path: '문서' });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await raw('문서/a.txt'), '첫 내용');
    assert.equal(readManifest(h.ctx.db, head()).has('문서/c.txt'), false, '그 시점에 없던 파일은 범위 안에서 지운다');
    assert.equal(await raw('사진/b.jpg'), '사진도 바뀜', '범위 밖은 그대로');
  });

  it('파일 하나 — 지운 파일도 되살린다', async () => {
    const point = head();
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/files?path=${encodeURIComponent('문서/a.txt')}`, headers: auth(owner) });
    const res = await restore({ snapshotId: point, path: '문서/a.txt' });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await raw('문서/a.txt'), '첫 내용');
  });

  it('그 시점에도 지금도 없는 경로는 404, 없는 시점도 404, 열람자는 403', async () => {
    assert.equal((await restore({ snapshotId: head(), path: '없는/곳' })).statusCode, 404);
    assert.equal((await restore({ snapshotId: 'snap_nope' })).statusCode, 404);
    const viewer = await signup(h.app, '열람자');
    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/invites`,
      headers: auth(owner),
      payload: { role: 'viewer' },
    });
    await h.app.inject({ method: 'POST', url: `/api/invites/${invite.json().invite.code}/join`, headers: auth(viewer) });
    const denied = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/restore`,
      headers: auth(viewer),
      payload: { snapshotId: head() },
    });
    assert.equal(denied.statusCode, 403);
  });

  it('되살릴 자리에 지금 같은 이름 파일이 있으면 409', async () => {
    const point = head(); // 문서/ 폴더가 있다
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/files?path=${encodeURIComponent('문서')}`, headers: auth(owner) });
    await uploadFile(h.app, owner, repoId, '문서', '이제 파일');
    const res = await restore({ snapshotId: point, path: '문서/a.txt' });
    assert.equal(res.statusCode, 409);
  });
});

describe('이력 보존 (솎기)', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  beforeEach(async () => {
    if (h) await h.close();
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '솎기');
  });
  after(async () => {
    await h.close();
  });

  /** 커밋 하나를 만들고 그 스냅샷 시각을 ageDays 전으로 옮긴다. */
  async function commitAt(path: string, content: string, at: number) {
    const res = await uploadFile(h.app, owner, repoId, path, content);
    const id = res.json().snapshotId as string;
    h.ctx.db.prepare('UPDATE snapshots SET created_at = ? WHERE id = ?').run(at, id);
    return id;
  }
  const snapshotIds = () =>
    (h.ctx.db.prepare('SELECT id FROM snapshots WHERE repo_id = ? ORDER BY created_at').all(repoId) as { id: string }[]).map(
      (row) => row.id,
    );
  const manifestOf = (id: string) =>
    [...readManifest(h.ctx.db, id).values()].map((e) => `${e.path}=${e.blob_hash.slice(0, 6)}`).sort().join(',');

  it('보존 기간이 지난 것은 지우고, 남은 시점의 파일 목록은 그대로다', async () => {
    const now = Date.now();
    const old1 = await commitAt('a.txt', 'v1', now - 90 * DAY);
    const old2 = await commitAt('b.txt', 'b', now - 60 * DAY);
    const old3 = await commitAt('a.txt', 'v2', now - 45 * DAY);
    const recent1 = await commitAt('a.txt', 'v3', now - 10 * DAY);
    const recent2 = await commitAt('c.txt', 'c', now - 1 * DAY);
    const before = new Map([recent1, recent2].map((id) => [id, manifestOf(id)]));
    void old1;
    void old2;
    void old3;

    const removed = pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    assert.equal(removed, 3);
    assert.deepEqual(snapshotIds(), [recent1, recent2]);
    for (const [id, manifest] of before) assert.equal(manifestOf(id), manifest, `시점 ${id} 의 목록`);
    // 가장 오래 남은 시점은 이제 처음부터 쌓은 것처럼 보인다.
    const first = h.ctx.db.prepare('SELECT parent_id FROM snapshots WHERE id = ?').get(recent1) as { parent_id: string | null };
    assert.equal(first.parent_id, null);
  });

  it('지운 시점에만 있던 내용은 GC 가 지운다 — 지금 파일과 남은 시점의 내용은 남는다', async () => {
    const now = Date.now();
    await commitAt('a.txt', '중간에만 있던 내용', now - 90 * DAY);
    await commitAt('a.txt', '남는 내용', now - 1 * DAY);
    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    const gc = await collectGarbage(h.ctx, 0);
    assert.equal(gc.removed, 1);
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=a.txt`, headers: auth(owner) });
    assert.equal(res.body, '남는 내용');
  });

  it('daily — 오래된 것 중 하루마다 마지막 하나는 남긴다', async () => {
    const now = Date.now();
    const dayA = new Date(now - 50 * DAY);
    dayA.setHours(10, 0, 0, 0);
    const a1 = await commitAt('a.txt', '1', dayA.getTime());
    const a2 = await commitAt('a.txt', '2', dayA.getTime() + 60 * 60 * 1000);
    const b1 = await commitAt('a.txt', '3', dayA.getTime() + DAY);
    const keepA2 = manifestOf(a2);
    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'daily', now });
    const left = snapshotIds();
    assert.ok(!left.includes(a1), '같은 날 앞의 것은 지운다');
    assert.ok(left.includes(a2) && left.includes(b1), '날마다 마지막 것은 남긴다');
    assert.equal(manifestOf(a2), keepA2);
  });

  it('열린 제안의 기준 시점은 남기고, 닫힌 제안이 가리키던 시점은 비운다', async () => {
    const now = Date.now();
    await commitAt('a.txt', 'v1', now - 90 * DAY);
    const base = await commitAt('a.txt', 'v2', now - 80 * DAY);
    const blob = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/uploads`,
      headers: auth(owner),
      payload: { name: 'a.txt', size: 2 },
    });
    const id = blob.json().upload.id;
    await h.app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}?offset=0`,
      headers: { ...auth(owner), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('v9'),
    });
    const done = await h.app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers: auth(owner) });
    const proposal = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(owner),
      payload: { title: '열린 제안', changes: [{ path: 'a.txt', blobHash: done.json().blob.hash }] },
    });
    assert.equal(proposal.statusCode, 201, proposal.body);
    await commitAt('a.txt', 'v3', now - 1 * DAY);

    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    assert.ok(snapshotIds().includes(base), '열린 제안의 기준은 남는다');
    const detail = await h.app.inject({ method: 'GET', url: `/api/proposals/${proposal.json().proposal.id}`, headers: auth(owner) });
    assert.deepEqual(detail.json().proposal.conflicts, ['a.txt'], '기준이 남아 충돌을 그대로 알아본다');

    await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.json().proposal.id}/close`, headers: auth(owner) });
    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    assert.ok(!snapshotIds().includes(base), '닫히면 기준도 정리 대상');
    const row = h.ctx.db.prepare('SELECT base_snapshot_id FROM proposals WHERE id = ?').get(proposal.json().proposal.id) as {
      base_snapshot_id: string | null;
    };
    assert.equal(row.base_snapshot_id, null);
  });

  it('기준 시점이 정리된 뒤 다시 연 제안도 제대로 판단한다', async () => {
    const now = Date.now();
    await commitAt('a.txt', 'v1', now - 90 * DAY);
    await commitAt('a.txt', 'v2', now - 80 * DAY);
    const blob = await h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/uploads`, headers: auth(owner), payload: { name: 'a.txt', size: 2 } });
    const id = blob.json().upload.id;
    await h.app.inject({ method: 'PUT', url: `/api/uploads/${id}?offset=0`, headers: { ...auth(owner), 'content-type': 'application/octet-stream' }, payload: Buffer.from('v9') });
    const done = await h.app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers: auth(owner) });
    const proposal = (await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(owner),
      payload: { title: '고침', changes: [{ path: 'a.txt', blobHash: done.json().blob.hash }] },
    })).json().proposal;
    await commitAt('other.txt', 'x', now - 1 * DAY);
    await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/close`, headers: auth(owner) });
    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/reopen`, headers: auth(owner) });
    const detail = await h.app.inject({ method: 'GET', url: `/api/proposals/${proposal.id}`, headers: auth(owner) });
    assert.deepEqual(detail.json().proposal.conflicts, [], 'a.txt 는 그 뒤 바뀌지 않았으니 충돌이 아니다');
    assert.equal(detail.json().proposal.mergeable, true);
    const merged = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/merge`, headers: auth(owner) });
    assert.equal(merged.statusCode, 200, merged.body);
  });

  it('보존 기간 0 이면 아무것도 지우지 않는다', async () => {
    const now = Date.now();
    await commitAt('a.txt', '1', now - 900 * DAY);
    await commitAt('a.txt', '2', now - 1 * DAY);
    assert.equal(pruneRepoHistory(h.ctx.db, repoId, { days: 0, keepOlder: 'none', now }), 0);
    assert.equal(snapshotIds().length, 2);
  });

  it('더하고 지운 파일은 합친 뒤 변경에서 사라진다', async () => {
    const now = Date.now();
    await commitAt('keep.txt', 'k', now - 100 * DAY);
    await commitAt('temp.txt', '잠깐', now - 90 * DAY);
    const res = await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/files?path=temp.txt`, headers: auth(owner) });
    h.ctx.db.prepare('UPDATE snapshots SET created_at = ? WHERE id = ?').run(now - 80 * DAY, res.json().snapshotId);
    const last = await commitAt('x.txt', 'x', now - 1 * DAY);
    pruneRepoHistory(h.ctx.db, repoId, { days: 30, keepOlder: 'none', now });
    const paths = (h.ctx.db.prepare('SELECT path FROM snapshot_changes WHERE snapshot_id = ?').all(last) as { path: string }[])
      .map((r) => r.path)
      .sort();
    assert.deepEqual(paths, ['keep.txt', 'x.txt']);
  });
});

describe('저장소 용량', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '용량');
  });
  after(async () => {
    await h.close();
  });

  it('지금 크기, 이력이 붙잡은 크기, 중복, 큰 파일을 알려준다', async () => {
    await uploadFile(h.app, owner, repoId, 'a.txt', '1234567890'); // 10
    await uploadFile(h.app, owner, repoId, '사본/a.txt', '1234567890'); // 같은 내용
    await uploadFile(h.app, owner, repoId, '사본/a2.txt', '1234567890');
    await uploadFile(h.app, owner, repoId, 'b.txt', '옛 내용');
    await uploadFile(h.app, owner, repoId, 'b.txt', '새 내용!');

    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/storage`, headers: auth(owner) });
    assert.equal(res.statusCode, 200, res.body);
    const report = res.json();
    assert.equal(report.current.files, 4);
    assert.equal(report.history.snapshots, 5);
    assert.equal(report.history.extraBytes, Buffer.byteLength('옛 내용'), '지금 없는 옛 내용만 센다');
    assert.equal(report.duplicates.length, 1);
    assert.deepEqual(report.duplicates[0].paths, ['a.txt', '사본/a.txt', '사본/a2.txt']);
    assert.equal(report.duplicateBytes, 20);
    assert.deepEqual(report.largest[0], { path: 'b.txt', size: Buffer.byteLength('새 내용!') });
    assert.deepEqual(report.retention, { days: 30, keepOlder: 'none' });
  });
});
