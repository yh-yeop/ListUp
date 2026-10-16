import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { auth, createHarness, createInvite, createRepo, join, signup, uploadFile, type Harness, type Session } from './helpers.ts';

describe('여러 개 한 번에 옮기기', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '주인');
  });
  after(async () => {
    await h.close();
  });
  beforeEach(async () => {
    repoId = await createRepo(h.app, owner, `옮기기-${Date.now()}-${Math.random()}`);
    await uploadFile(h.app, owner, repoId, 'a.txt', 'A');
    await uploadFile(h.app, owner, repoId, 'b.txt', 'B');
    await uploadFile(h.app, owner, repoId, '사진/1.jpg', '1');
    await uploadFile(h.app, owner, repoId, '사진/2.jpg', '2');
  });

  const move = (payload: unknown) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/files/move`, headers: auth(owner), payload: payload as object });
  const paths = async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/files?recursive=1`, headers: auth(owner) });
    return (res.json().tree.files as { path: string }[]).map((file) => file.path).sort();
  };
  const history = async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/history`, headers: auth(owner) });
    return res.json().snapshots as { message: string }[];
  };

  it('파일과 폴더를 한 폴더로 — 스냅샷 하나', async () => {
    const before = (await history()).length;
    const res = await move({ moves: [{ from: 'a.txt', to: '보관/a.txt' }, { from: '사진', to: '보관/사진' }] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().moved, 3);
    assert.deepEqual(await paths(), ['b.txt', '보관/a.txt', '보관/사진/1.jpg', '보관/사진/2.jpg']);
    const snapshots = await history();
    assert.equal(snapshots.length, before + 1);
    assert.match(snapshots[0].message, /^이동 2개 → 보관\/: a\.txt, 사진/);
  });

  it('서로 자리를 맞바꾸는 것도 한 번에 된다(순서에 기대지 않음)', async () => {
    const res = await move({ moves: [{ from: 'a.txt', to: 'b.txt' }, { from: 'b.txt', to: 'a.txt' }] });
    assert.equal(res.statusCode, 200, res.body);
    const raw = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=a.txt`, headers: auth(owner) });
    assert.equal(raw.body, 'B');
  });

  it('겹치는 고름·같은 자리·없는 것은 거절하고 아무것도 바꾸지 않는다', async () => {
    const nested = await move({ moves: [{ from: '사진', to: '보관/사진' }, { from: '사진/1.jpg', to: '1.jpg' }] });
    assert.equal(nested.statusCode, 400);
    assert.match(nested.json().error.message, /함께 옮길 수 없습니다/);

    const sameTarget = await move({ moves: [{ from: 'a.txt', to: 'c.txt' }, { from: 'b.txt', to: 'c.txt' }] });
    assert.equal(sameTarget.statusCode, 409);

    const fileVsFolder = await move({ moves: [{ from: 'a.txt', to: 'x' }, { from: 'b.txt', to: 'x/b.txt' }] });
    assert.equal(fileVsFolder.statusCode, 409);

    const missing = await move({ moves: [{ from: 'a.txt', to: '보관/a.txt' }, { from: '없음', to: '보관/없음' }] });
    assert.equal(missing.statusCode, 404);

    assert.equal((await move({ moves: [] })).statusCode, 400);
    assert.deepEqual(await paths(), ['a.txt', 'b.txt', '사진/1.jpg', '사진/2.jpg']);
  });

  it('하나만 주는 예전 모양도 그대로', async () => {
    const res = await move({ from: '사진', to: '앨범' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await paths(), ['a.txt', 'b.txt', '앨범/1.jpg', '앨범/2.jpg']);
    assert.equal((await history())[0].message, '이동: 사진 → 앨범');
  });
});

describe('이동 제안', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '주인');
    viewer = await signup(h.app, '열람자');
  });
  after(async () => {
    await h.close();
  });
  beforeEach(async () => {
    repoId = await createRepo(h.app, owner, `이동제안-${Date.now()}-${Math.random()}`);
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);
    await uploadFile(h.app, owner, repoId, '할일.md', '할 일');
    await uploadFile(h.app, owner, repoId, '사진/1.jpg', '1');
  });

  const propose = (changes: unknown[]) =>
    h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(viewer),
      payload: { title: '정리', changes },
    });
  const paths = async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/files?recursive=1`, headers: auth(owner) });
    return (res.json().tree.files as { path: string }[]).map((file) => file.path).sort();
  };

  it('열람자가 옮기기를 제안하면 지우기+더하기 한 쌍이 생기고, 반영하면 옮겨진다', async () => {
    const res = await propose([{ path: '문서/할일.md', movedFrom: '할일.md' }]);
    assert.equal(res.statusCode, 201, res.body);
    const proposal = res.json().proposal;
    const changes = proposal.changes as { path: string; op: string; movedFrom: string | null; blobHash: string | null }[];
    assert.deepEqual(
      changes.map((c) => [c.path, c.op, c.movedFrom]),
      [
        ['문서/할일.md', 'add', '할일.md'],
        ['할일.md', 'delete', null],
      ],
    );
    assert.ok(changes[0].blobHash, '원래 파일의 내용을 그대로 담는다');
    assert.equal(proposal.mergeable, true);

    const merge = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/merge`, headers: auth(owner) });
    assert.equal(merge.statusCode, 200, merge.body);
    assert.deepEqual(await paths(), ['문서/할일.md', '사진/1.jpg']);
    const raw = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('문서/할일.md')}`, headers: auth(owner) });
    assert.equal(raw.body, '할 일');
  });

  it('없는 원본, 이미 있는 자리, 원본을 따로 또 담으면 400', async () => {
    assert.equal((await propose([{ path: 'x.md', movedFrom: '없음.md' }])).statusCode, 400);
    assert.equal((await propose([{ path: '사진/1.jpg', movedFrom: '할일.md' }])).statusCode, 400);
    const twice = await propose([{ path: '할일.md', blobHash: null }, { path: '문서/할일.md', movedFrom: '할일.md' }]);
    assert.equal(twice.statusCode, 400);
    assert.match(twice.json().error.message, /두 번/);
  });

  it('충돌 정리에서 한쪽을 빼면 이동이 통째로 빠진다(복사나 삭제로 남지 않게)', async () => {
    const res = await propose([{ path: '보관/할일.md', movedFrom: '할일.md' }, { path: '사진/1.jpg', blobHash: null }]);
    const proposal = res.json().proposal;
    // 그새 저장소에서 원본이 바뀌었다 — 원본의 삭제 줄이 충돌이 된다.
    await uploadFile(h.app, owner, repoId, '할일.md', '고친 할 일');
    const detail = await h.app.inject({ method: 'GET', url: `/api/proposals/${proposal.id}`, headers: auth(owner) });
    assert.deepEqual(detail.json().proposal.conflicts, ['할일.md']);

    const resolve = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/resolve`,
      headers: auth(owner),
      payload: { resolutions: { '할일.md': 'theirs' } },
    });
    assert.equal(resolve.statusCode, 200, resolve.body);
    const left = resolve.json().proposal.changes as { path: string }[];
    assert.deepEqual(left.map((c) => c.path), ['사진/1.jpg']);
    assert.ok(resolve.json().proposal.comments.at(-1).body.includes('이동을 통째로 제안에서 뺌'));
  });
});
