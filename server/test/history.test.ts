import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FileVersion, Snapshot, TrashEntry } from '@listup/shared';
import {
  auth,
  createHarness,
  createInvite,
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

describe('파일 버전과 휴지통', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  const get = async (session: Session, url: string) => {
    const res = await h.app.inject({ method: 'GET', url, headers: auth(session) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const versions = async (path: string, query = '') =>
    (await get(owner, `/api/repos/${repoId}/files/versions?path=${encodeURIComponent(path)}${query}`)) as {
      versions: FileVersion[];
      next: { before: number; beforeId: string } | null;
    };
  const trash = async () => ((await get(owner, `/api/repos/${repoId}/trash`)) as { entries: TrashEntry[] }).entries;
  const remove = (path: string) =>
    h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/files?path=${encodeURIComponent(path)}`, headers: auth(owner) });
  const move = (from: string, to: string) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/files/move`, headers: auth(owner), payload: { from, to } });
  const commit = (changes: { path: string; blobHash: string | null }[]) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/files/commit`, headers: auth(owner), payload: { changes } });

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '열람자');
    repoId = await createRepo(h.app, owner, '되돌리기');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    const join = await h.app.inject({ method: 'POST', url: `/api/invites/${invite.code}/join`, headers: auth(viewer) });
    assert.equal(join.statusCode, 200, join.body);
  });
  after(async () => {
    await h.close();
  });

  it('파일 하나를 바꾼 시점들을 최근 것부터 — 추가·수정·삭제', async () => {
    await uploadFile(h.app, owner, repoId, '노래/a.mp3', '첫 내용');
    await uploadFile(h.app, owner, repoId, '다른.txt', '상관없음');
    await uploadFile(h.app, owner, repoId, '노래/a.mp3', '둘째 내용');
    assert.equal((await remove('노래/a.mp3')).statusCode, 200);

    const { versions: list } = await versions('노래/a.mp3');
    assert.deepEqual(list.map((v) => v.op), ['deleted', 'updated', 'added']);
    assert.equal(list[0].blobHash, null);
    assert.equal(list[1].size, Buffer.byteLength('둘째 내용'));
    assert.equal(list[2].author.displayName, '소유자');
    // 다른 파일의 변경은 섞이지 않는다.
    assert.equal(list.length, 3);
  });

  it('버전 목록은 커서로 나눠 받는다', async () => {
    const first = await versions('노래/a.mp3', '&limit=2');
    assert.equal(first.versions.length, 2);
    assert.ok(first.next);
    const rest = await versions(
      '노래/a.mp3',
      `&limit=2&before=${first.next!.before}&beforeId=${first.next!.beforeId}`,
    );
    assert.deepEqual(rest.versions.map((v) => v.op), ['added']);
    assert.equal(rest.next, null);
  });

  it('없는 경로는 빈 목록, 잘못된 경로는 400', async () => {
    assert.deepEqual((await versions('없는.txt')).versions, []);
    const bad = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files/versions?path=${encodeURIComponent('../x')}`,
      headers: auth(owner),
    });
    assert.equal(bad.statusCode, 400);
  });

  it('휴지통 — 지운 파일과 지우기 전 내용, 지우기 전 시점', async () => {
    const entries = await trash();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.path, '노래/a.mp3');
    assert.equal(entry.name, 'a.mp3');
    assert.equal(entry.size, Buffer.byteLength('둘째 내용'));
    const { versions: list } = await versions('노래/a.mp3');
    assert.equal(entry.blobHash, list[1].blobHash);
    assert.equal(entry.snapshotId, list[0].snapshotId);
    // 지우기 바로 전 시점에는 그 파일이 있다.
    const before = await get(owner, `/api/repos/${repoId}/files?path=${encodeURIComponent('노래')}&snapshot=${entry.beforeSnapshotId}`);
    assert.deepEqual(
      (before as { tree: { files: { name: string }[] } }).tree.files.map((f) => f.name),
      ['a.mp3'],
    );
  });

  it('지운 내용으로 다시 커밋하면 되돌아오고 휴지통에서 빠진다', async () => {
    const [entry] = await trash();
    const res = await commit([{ path: entry.path, blobHash: entry.blobHash }]);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(await trash(), []);
    const { versions: list } = await versions('노래/a.mp3');
    assert.equal(list[0].op, 'added');
    assert.equal(list[0].blobHash, entry.blobHash);
  });

  it('예전 버전으로 되돌리기 — 이력에 있던 내용은 다시 올리지 않고 커밋할 수 있다', async () => {
    const { versions: list } = await versions('노래/a.mp3');
    const oldest = list[list.length - 1];
    const res = await commit([{ path: '노래/a.mp3', blobHash: oldest.blobHash }]);
    assert.equal(res.statusCode, 201, res.body);
    const raw = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('노래/a.mp3')}`,
      headers: auth(owner),
    });
    assert.equal(raw.body, '첫 내용');
  });

  it('이름 바꾸기·옮기기는 휴지통에 들어가지 않는다', async () => {
    assert.equal((await move('다른.txt', '옮김/다른.txt')).statusCode, 200);
    assert.deepEqual(await trash(), []);
  });

  it('같은 파일을 여러 번 지웠으면 마지막 한 번만', async () => {
    await uploadFile(h.app, owner, repoId, 'b.txt', '하나');
    await remove('b.txt');
    await uploadFile(h.app, owner, repoId, 'b.txt', '둘');
    await remove('b.txt');
    const entries = (await trash()).filter((e) => e.path === 'b.txt');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].size, Buffer.byteLength('둘'));
  });

  it('폴더를 지우면 안의 파일이 같은 시점으로 묶여 들어간다', async () => {
    await uploadFile(h.app, owner, repoId, '앨범/1.mp3', '1');
    await uploadFile(h.app, owner, repoId, '앨범/2.mp3', '2');
    assert.equal((await remove('앨범')).statusCode, 200);
    const entries = (await trash()).filter((e) => e.path.startsWith('앨범/'));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].snapshotId, entries[1].snapshotId);
  });

  it('열람자도 버전과 휴지통을 본다', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/trash`, headers: auth(viewer) });
    assert.equal(res.statusCode, 200);
    const stranger = await signup(h.app, '남');
    const denied = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/trash`, headers: auth(stranger) });
    assert.equal(denied.statusCode, 404);
  });
});
