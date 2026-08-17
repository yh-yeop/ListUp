import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TreeListing } from '@listup/shared';
import {
  auth,
  createHarness,
  createInvite,
  createRepo,
  join,
  signup,
  uploadFile,
  type Harness,
  type Session,
} from './helpers.ts';
import { contentDisposition } from '../src/routes/files.ts';

describe('저장소와 파일', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '사진 모음');
  });
  after(async () => {
    await h.close();
  });

  it('만든 사람이 소유자로 들어간다', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    assert.equal(res.statusCode, 200);
    const repo = res.json().repo;
    assert.equal(repo.role, 'owner');
    assert.equal(repo.memberCount, 1);
    assert.equal(repo.fileCount, 0);
    assert.equal(repo.headSnapshotId, null);
  });

  it('파일을 올리면 스냅샷이 생기고 목록에 보인다', async () => {
    const res = await uploadFile(h.app, owner, repoId, '문서/계획.txt', '첫 번째 내용');
    assert.equal(res.statusCode, 201);
    const uploaded = res.json();
    assert.equal(uploaded.file.path, '문서/계획.txt');
    assert.equal(uploaded.file.mimeType, 'text/plain');
    assert.ok(uploaded.snapshotId);

    const root = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files`,
      headers: auth(owner),
    });
    const tree = root.json().tree as TreeListing;
    assert.deepEqual(
      tree.dirs.map((d) => d.name),
      ['문서'],
    );
    assert.equal(tree.dirs[0].fileCount, 1);
    assert.equal(tree.files.length, 0);

    const sub = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('문서')}`,
      headers: auth(owner),
    });
    const subTree = sub.json().tree as TreeListing;
    assert.deepEqual(
      subTree.files.map((f) => f.name),
      ['계획.txt'],
    );
  });

  it('내용이 같으면 새 스냅샷을 만들지 않는다', async () => {
    const before = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    const headBefore = before.json().repo.headSnapshotId;

    const res = await uploadFile(h.app, owner, repoId, '문서/계획.txt', '첫 번째 내용');
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().unchanged, true);
    assert.equal(res.json().snapshotId, headBefore);
  });

  it('같은 경로에 다시 올리면 이전 버전이 히스토리에 남는다', async () => {
    const first = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    const oldSnapshot = first.json().repo.headSnapshotId;

    await uploadFile(h.app, owner, repoId, '문서/계획.txt', '두 번째 내용');

    const current = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('문서/계획.txt')}`,
      headers: auth(owner),
    });
    assert.equal(current.body, '두 번째 내용');

    const old = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('문서/계획.txt')}&snapshot=${oldSnapshot}`,
      headers: auth(owner),
    });
    assert.equal(old.body, '첫 번째 내용');

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/history`,
      headers: auth(owner),
    });
    assert.ok(history.json().snapshots.length >= 2);
  });

  it('다운로드는 실행 가능한 타입으로 해석되지 않게 내려준다', async () => {
    await uploadFile(h.app, owner, repoId, '위험.html', '<script>alert(1)</script>');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('위험.html')}&inline=1`,
      headers: auth(owner),
    });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    // text/html 은 inline 허용 목록에 없으므로 attachment 로 강제된다.
    assert.match(String(res.headers['content-disposition']), /^attachment;/);
  });

  it('경로 탈출 시도를 거부한다', async () => {
    const res = await uploadFile(h.app, owner, repoId, '../탈출.txt', 'x');
    assert.equal(res.statusCode, 400);

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=..%2F..%2Fetc%2Fpasswd`,
      headers: auth(owner),
    });
    assert.equal(read.statusCode, 400);
  });

  it('폴더를 지우면 아래 파일이 모두 사라진다', async () => {
    await uploadFile(h.app, owner, repoId, '임시/a.txt', 'a');
    await uploadFile(h.app, owner, repoId, '임시/하위/b.txt', 'b');

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('임시')}`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed.length, 2);

    const tree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files`,
      headers: auth(owner),
    });
    assert.equal(
      (tree.json().tree as TreeListing).dirs.some((d) => d.name === '임시'),
      false,
    );
  });

  it('폴더를 통째로 옮길 수 있다', async () => {
    await uploadFile(h.app, owner, repoId, '옮길폴더/c.txt', 'c');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/files/move`,
      headers: auth(owner),
      payload: { from: '옮길폴더', to: '보관/옮긴폴더' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().moved, 1);

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보관/옮긴폴더/c.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, 'c');
  });

  it('멤버가 아니면 저장소가 있는지조차 알 수 없다', async () => {
    const outsider = await signup(h.app, '외부인');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}`,
      headers: auth(outsider),
    });
    assert.equal(res.statusCode, 404);
  });

  it('열람 권한만 있으면 파일을 직접 못 올린다', async () => {
    const viewer = await signup(h.app, '열람자');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files`,
      headers: auth(viewer),
    });
    assert.equal(read.statusCode, 200);

    const write = await uploadFile(h.app, viewer, repoId, '몰래.txt', 'x');
    assert.equal(write.statusCode, 403);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('문서/계획.txt')}`,
      headers: auth(viewer),
    });
    assert.equal(remove.statusCode, 403);
  });
});

describe('Content-Disposition', () => {
  it('한글 파일명을 RFC 5987 형식으로 함께 넣는다', () => {
    const header = contentDisposition('보고서.pdf', false);
    assert.match(header, /^attachment;/);
    // ASCII 대체 이름과 UTF-8 원본 이름을 함께 준다.
    assert.ok(header.includes('filename="___.pdf"'));
    assert.ok(header.includes(`filename*=UTF-8''${encodeURIComponent('보고서.pdf')}`));
  });

  it('따옴표와 개행을 무해하게 만든다', () => {
    const header = contentDisposition('a"b\nc.txt', false);
    assert.equal(header.includes('\n'), false);
    assert.equal(header.split('filename="')[1].split('"')[0].includes('"'), false);
  });
});
