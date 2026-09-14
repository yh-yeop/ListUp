import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  auth,
  createHarness,
  createInvite,
  createRepo,
  join,
  signup,
  uploadBlob,
  uploadFile,
  type Harness,
  type Session,
} from './helpers.ts';

/** 여러 파일을 커밋 하나로 반영 (POST /repos/:id/files/commit). */
describe('여러 파일 커밋', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '열람자');
    repoId = await createRepo(h.app, owner, '커밋');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);
  });
  after(async () => {
    await h.close();
  });

  const commit = (session: Session, changes: unknown, id = repoId) =>
    h.app.inject({
      method: 'POST',
      url: `/api/repos/${id}/files/commit`,
      headers: auth(session),
      payload: { changes },
    });
  const history = async () =>
    (
      await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/history`, headers: auth(owner) })
    ).json() as { snapshots: { id: string; message: string; fileCount: number }[] };
  const files = async (path = '', snapshot?: string) =>
    (
      await h.app.inject({
        method: 'GET',
        url: `/api/repos/${repoId}/files?path=${encodeURIComponent(path)}${snapshot ? `&snapshot=${snapshot}` : ''}`,
        headers: auth(owner),
      })
    ).json() as { tree: { dirs: { name: string }[]; files: { name: string }[] } };

  it('파일 여러 개가 스냅샷 하나로 들어간다', async () => {
    const hashes = await Promise.all(
      ['a.txt', 'b.txt', 'c.txt'].map((name) => uploadBlob(h.app, owner, repoId, name, `내용 ${name}`)),
    );
    const before = (await history()).snapshots.length;
    const res = await commit(owner, [
      { path: '폴더/a.txt', blobHash: hashes[0] },
      { path: '폴더/b.txt', blobHash: hashes[1] },
      { path: '폴더/깊이/c.txt', blobHash: hashes[2] },
    ]);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual({ ...(res.json() as Record<string, unknown>), snapshotId: undefined }, { snapshotId: undefined, unchanged: false, added: 3, updated: 0, deleted: 0 });

    const after = (await history()).snapshots;
    assert.equal(after.length, before + 1, '스냅샷은 하나만 생긴다');
    assert.equal(after[0].fileCount, 3);
    assert.equal(after[0].message, '여러 파일 — 추가 3');
    const tree = await files('폴더');
    assert.deepEqual(tree.tree.files.map((f) => f.name), ['a.txt', 'b.txt']);
    assert.deepEqual(tree.tree.dirs.map((d) => d.name), ['깊이']);
  });

  it('추가·수정·삭제를 섞을 수 있고, 내용이 같은 파일은 건너뛴다', async () => {
    const same = (await files('폴더')).tree.files.length;
    assert.equal(same, 2);
    const newB = await uploadBlob(h.app, owner, repoId, 'b.txt', '바뀐 b');
    const d = await uploadBlob(h.app, owner, repoId, 'd.txt', 'd');
    const unchangedA = await uploadBlob(h.app, owner, repoId, 'a.txt', '내용 a.txt');

    const res = await commit(owner, [
      { path: '폴더/a.txt', blobHash: unchangedA },
      { path: '폴더/b.txt', blobHash: newB },
      { path: '폴더/깊이/c.txt', blobHash: null },
      { path: 'd.txt', blobHash: d },
    ]);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.deepEqual([body.added, body.updated, body.deleted], [1, 1, 1]);
  });

  it('바뀐 것이 없으면 스냅샷을 만들지 않는다', async () => {
    const head = (await history()).snapshots[0].id;
    const d = await uploadBlob(h.app, owner, repoId, 'd.txt', 'd');
    const res = await commit(owner, [{ path: 'd.txt', blobHash: d }]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().unchanged, true);
    assert.equal((await history()).snapshots[0].id, head);
  });

  it('지난 시점도 그대로 볼 수 있다 (바뀐 것만 기록해도)', async () => {
    const snapshots = (await history()).snapshots;
    // 두 번째로 최근 스냅샷(추가 3개) 시점: 폴더/깊이/c.txt 가 아직 있다.
    const target = snapshots.find((s) => s.message === '여러 파일 — 추가 3')!;
    const past = await files('폴더/깊이', target.id);
    assert.deepEqual(past.tree.files.map((f) => f.name), ['c.txt']);
    const now = await files('폴더/깊이');
    assert.deepEqual(now.tree.files, []);

    const raw = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('폴더/b.txt')}&snapshot=${target.id}`,
      headers: auth(owner),
    });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.body, '내용 b.txt');
  });

  it('다른 저장소에 올린 파일은 가져올 수 없다', async () => {
    const other = await createRepo(h.app, owner, '다른 저장소');
    const foreign = await uploadBlob(h.app, owner, other, 'secret.txt', '남의 파일');
    const res = await commit(owner, [{ path: 'secret.txt', blobHash: foreign }]);
    assert.equal(res.statusCode, 400);
  });

  it('지난 이력에 있던 파일은 되살릴 수 있다', async () => {
    // 폴더/깊이/c.txt 는 앞에서 지웠다.
    const up = await uploadFile(h.app, owner, repoId, 'tmp.txt', '내용 c.txt');
    const hash = up.json().file.blobHash as string;
    const res = await commit(owner, [{ path: '되살림/c.txt', blobHash: hash }]);
    assert.equal(res.statusCode, 201, res.body);
  });

  it('없는 파일 삭제·중복 경로·잘못된 경로·해시는 400', async () => {
    const d = await uploadBlob(h.app, owner, repoId, 'd.txt', 'd');
    assert.equal((await commit(owner, [{ path: 'none.txt', blobHash: null }])).statusCode, 400);
    assert.equal(
      (await commit(owner, [
        { path: 'x.txt', blobHash: d },
        { path: 'x.txt', blobHash: d },
      ])).statusCode,
      400,
    );
    assert.equal((await commit(owner, [{ path: '../x', blobHash: d }])).statusCode, 400);
    assert.equal((await commit(owner, [{ path: 'y.txt', blobHash: 'abc' }])).statusCode, 400);
    assert.equal((await commit(owner, [])).statusCode, 400);
  });

  it('새 파일끼리 파일·폴더 이름이 겹치면 409 이고 아무것도 반영하지 않는다', async () => {
    const before = (await history()).snapshots.length;
    const a = await uploadBlob(h.app, owner, repoId, 'n', 'n');
    const res = await commit(owner, [
      { path: '겹침', blobHash: a },
      { path: '겹침/안.txt', blobHash: a },
    ]);
    assert.equal(res.statusCode, 409);
    assert.equal((await history()).snapshots.length, before);
  });

  it('열람 권한으로는 커밋할 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, 'v.txt', 'v');
    assert.equal((await commit(viewer, [{ path: 'v.txt', blobHash: hash }])).statusCode, 403);
  });
});
