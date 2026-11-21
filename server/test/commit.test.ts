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

  it('expect — 그 사이 다른 사람이 바꾼 파일이면 409 이고 아무것도 반영하지 않는다 (여러 개 옮기기·지우기)', async () => {
    // 목록을 본 뒤 다른 사람이 새 버전을 올렸는데 옛 목록으로 옮기면, 새 자리에 옛 내용이 들어가고 새 버전은 머리에서
    // 사라졌다(이력에만 남음). 옮길 자리에 그 사이 생긴 파일도 조용히 덮어썼다.
    const v1 = await uploadBlob(h.app, owner, repoId, '보고서.txt', '처음');
    assert.equal((await commit(owner, [{ path: '기대/보고서.txt', blobHash: v1 }])).statusCode, 201);
    const v2 = await uploadBlob(h.app, owner, repoId, '보고서.txt', '다른 사람이 고침');
    assert.equal((await commit(owner, [{ path: '기대/보고서.txt', blobHash: v2 }])).statusCode, 201);

    const before = (await history()).snapshots.length;
    const stale = await commit(owner, [
      { path: '보관/보고서.txt', blobHash: v1, expect: null },
      { path: '기대/보고서.txt', blobHash: null, expect: v1 },
    ]);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual((stale.json() as { error: { details?: { stale?: string[] } } }).error.details?.stale, ['기대/보고서.txt']);
    assert.equal((await history()).snapshots.length, before, '아무것도 반영하지 않는다');

    // 옮길 자리에 그 사이 같은 이름이 생겼으면(expect: null) 덮어쓰지 않는다.
    const there = await uploadBlob(h.app, owner, repoId, '보고서.txt', '먼저 와 있던 것');
    assert.equal((await commit(owner, [{ path: '보관/보고서.txt', blobHash: there }])).statusCode, 201);
    const clash = await commit(owner, [
      { path: '보관/보고서.txt', blobHash: v2, expect: null },
      { path: '기대/보고서.txt', blobHash: null, expect: v2 },
    ]);
    assert.equal(clash.statusCode, 409);
    assert.deepEqual((clash.json() as { error: { details?: { stale?: string[] } } }).error.details?.stale, ['보관/보고서.txt']);

    // 맞으면 그대로 된다.
    const ok = await commit(owner, [
      { path: '보관2/보고서.txt', blobHash: v2, expect: null },
      { path: '기대/보고서.txt', blobHash: null, expect: v2 },
    ]);
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal((await commit(owner, [{ path: 'x.txt', blobHash: null, expect: 'nothex' }])).statusCode, 400);
  });

  it('파일이 많은 폴더도 커밋 하나로 지운다 — JSON 본문 1MB 한도에 걸리지 않는다', async () => {
    // 앱은 폴더 지우기를 "안의 파일을 읽은 내용대로만 지우는 커밋"(expect)으로 한다(되돌리기용). 경로가 긴 파일 수천 개면
    // 본문이 1MB 를 넘어, DELETE 로는 되던 폴더 지우기가 413 으로 막혔다 (2026-11-21 검토).
    const big = await createRepo(h.app, owner, '큰 폴더');
    const hash = await uploadBlob(h.app, owner, big, 'x.txt', '같은 내용');
    const longName = '아주긴한글파일이름'.repeat(10);
    const paths = Array.from({ length: 3000 }, (_, i) => `큰폴더/${longName}-${i}.txt`);
    const add = await commit(owner, paths.map((path) => ({ path, blobHash: hash })), big);
    assert.equal(add.statusCode, 201, add.body.slice(0, 200));
    const removal = paths.map((path) => ({ path, blobHash: null, expect: hash }));
    assert.ok(Buffer.byteLength(JSON.stringify({ changes: removal })) > 1024 * 1024, '시험 본문이 1MB 를 넘어야 한다');
    const del = await commit(owner, removal, big);
    assert.equal(del.statusCode, 201, del.body.slice(0, 200));
    assert.equal((del.json() as { deleted: number }).deleted, 3000);
  });

  it('열람 권한으로는 커밋할 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, 'v.txt', 'v');
    assert.equal((await commit(viewer, [{ path: 'v.txt', blobHash: hash }])).statusCode, 403);
  });
});
