import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TreeListing } from '@listup/shared';
import { MAX_NAME_LENGTH } from '@listup/shared';
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

describe('저장소 관리', () => {
  let h: Harness;
  let owner: Session;
  let editor: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    editor = await signup(h.app, '편집자');
    repoId = await createRepo(h.app, owner, '원래 이름');
    const invite = await createInvite(h.app, owner, repoId, { role: 'editor' });
    assert.equal((await join(h.app, editor, invite.code)).statusCode, 200);
  });
  after(async () => {
    await h.close();
  });

  it('소유자만 이름과 설명을 바꿀 수 있다', async () => {
    const byEditor = await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}`,
      headers: auth(editor),
      payload: { name: '편집자가 바꾼 이름' },
    });
    assert.equal(byEditor.statusCode, 403);

    const byOwner = await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}`,
      headers: auth(owner),
      payload: { name: '  새 이름  ', description: '팀 자료 모음' },
    });
    assert.equal(byOwner.statusCode, 200);
    assert.equal(byOwner.json().repo.name, '새 이름');
    assert.equal(byOwner.json().repo.description, '팀 자료 모음');

    // 설명만 주면 이름은 그대로다.
    const onlyDescription = await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}`,
      headers: auth(owner),
      payload: { description: '' },
    });
    assert.equal(onlyDescription.statusCode, 200);
    assert.equal(onlyDescription.json().repo.name, '새 이름');
    assert.equal(onlyDescription.json().repo.description, '');
  });

  it('이름이 비거나 너무 길거나 문자열이 아니면 400 이다', async () => {
    for (const name of ['   ', 'a'.repeat(MAX_NAME_LENGTH + 1), 123]) {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/repos/${repoId}`,
        headers: auth(owner),
        payload: { name },
      });
      assert.equal(res.statusCode, 400, `name=${JSON.stringify(name)}`);
    }
    // 실패한 요청이 이름을 바꾸지 않았다.
    const check = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}`,
      headers: auth(owner),
    });
    assert.equal(check.json().repo.name, '새 이름');
  });

  it('저장소를 지우면 멤버·초대·제안이 사라지고 이전 멤버에게는 404 다', async () => {
    const doomedId = await createRepo(h.app, owner, '지울 저장소');
    const invite = await createInvite(h.app, owner, doomedId, { role: 'editor' });
    assert.equal((await join(h.app, editor, invite.code)).statusCode, 200);
    assert.equal((await uploadFile(h.app, owner, doomedId, '문서.txt', '내용')).statusCode, 201);
    const hash = await uploadBlob(h.app, editor, doomedId, '제안.txt', '제안 내용');
    const proposal = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${doomedId}/proposals`,
      headers: auth(editor),
      payload: { title: '제안 하나', changes: [{ path: '제안.txt', blobHash: hash }] },
    });
    assert.equal(proposal.statusCode, 201);

    const byEditor = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${doomedId}`,
      headers: auth(editor),
    });
    assert.equal(byEditor.statusCode, 403);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${doomedId}`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 200);

    // 이전 멤버에게는 저장소도, 그 초대 코드도 더 이상 없다.
    const gone = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${doomedId}`,
      headers: auth(editor),
    });
    assert.equal(gone.statusCode, 404);
    const invitePreview = await h.app.inject({
      method: 'GET',
      url: `/api/invites/${invite.code}`,
      headers: auth(editor),
    });
    assert.equal(invitePreview.statusCode, 404);
    const list = await h.app.inject({ method: 'GET', url: '/api/repos', headers: auth(editor) });
    assert.ok(!list.json().repos.some((r: { id: string }) => r.id === doomedId));

    // 딸린 행들도 함께 지워졌다 (ON DELETE CASCADE).
    const count = (table: string) =>
      h.ctx.db
        .prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE repo_id = ?`)
        .get(doomedId)!.c;
    for (const table of ['repo_members', 'invites', 'proposals', 'snapshots', 'repo_blobs']) {
      assert.equal(count(table), 0, table);
    }
  });

  it('snapshot 쿼리로 이전 시점의 목록과 파일을 볼 수 있다', async () => {
    const first = await uploadFile(h.app, owner, repoId, '기록/a.txt', '첫 번째');
    assert.equal(first.statusCode, 201);
    const oldSnapshot = (first.json() as { snapshotId: string }).snapshotId;
    assert.equal((await uploadFile(h.app, owner, repoId, '기록/a.txt', '두 번째')).statusCode, 201);
    assert.equal((await uploadFile(h.app, owner, repoId, '기록/b.txt', '추가')).statusCode, 201);

    // 과거 시점 목록에는 그때의 파일만 있다.
    const oldTree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('기록')}&snapshot=${oldSnapshot}`,
      headers: auth(owner),
    });
    assert.equal(oldTree.statusCode, 200);
    const listing = oldTree.json().tree as TreeListing;
    assert.deepEqual(listing.files.map((f) => f.name), ['a.txt']);

    const headTree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('기록')}`,
      headers: auth(owner),
    });
    assert.deepEqual(
      (headTree.json().tree as TreeListing).files.map((f) => f.name).sort(),
      ['a.txt', 'b.txt'],
    );

    // 같은 경로의 과거 내용도 받을 수 있다.
    const oldRaw = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('기록/a.txt')}&snapshot=${oldSnapshot}`,
      headers: auth(owner),
    });
    assert.equal(oldRaw.statusCode, 200);
    assert.equal(oldRaw.body, '첫 번째');
    const headRaw = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('기록/a.txt')}`,
      headers: auth(owner),
    });
    assert.equal(headRaw.body, '두 번째');

    // 그 시점에 없던 파일은 404.
    const missing = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('기록/b.txt')}&snapshot=${oldSnapshot}`,
      headers: auth(owner),
    });
    assert.equal(missing.statusCode, 404);

    // 다른 저장소의 스냅샷 ID 로는 볼 수 없다.
    const otherId = await createRepo(h.app, owner, '다른 저장소');
    const otherUpload = await uploadFile(h.app, owner, otherId, '남의것.txt', '남의 내용');
    const otherSnapshot = (otherUpload.json() as { snapshotId: string }).snapshotId;
    const crossed = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?snapshot=${otherSnapshot}`,
      headers: auth(owner),
    });
    assert.equal(crossed.statusCode, 404);
  });
});

describe('로그인 토큰', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  it('로그인 성공 시 받은 토큰으로 /auth/me 를 부를 수 있다', async () => {
    const created = await signup(h.app, '로그인 사용자');
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: created.email, password: 'password1234' },
    });
    assert.equal(login.statusCode, 200);
    const token = (login.json() as { token: string }).token;
    assert.ok(token);

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, created.userId);
    assert.equal(me.json().user.email, created.email);
  });
});

describe('웹 정적 서빙', () => {
  const INDEX_HTML = '<!doctype html><title>ListUp</title><div id="root"></div>';
  let h: Harness;
  let webDir: string;

  before(async () => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-web-'));
    fs.writeFileSync(path.join(webDir, 'index.html'), INDEX_HTML);
    fs.mkdirSync(path.join(webDir, '_expo', 'static', 'js', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(webDir, '_expo', 'static', 'js', 'web', 'entry-abc123.js'),
      'console.log(1);',
    );
    fs.writeFileSync(path.join(webDir, '.env'), 'SECRET=1');
    h = await createHarness({ webDir });
  });
  after(async () => {
    await h.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  it('루트는 index.html 을 재검증 캐시로 준다', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.equal(res.body, INDEX_HTML);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('앱 라우트는 index.html 로 넘긴다 (SPA 폴백)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/repo/abc' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.equal(res.body, INDEX_HTML);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('/api 아래의 없는 경로는 JSON 404 다', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.json().error.code, 'not_found');
  });

  it('숨김 파일은 주지 않는다', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/.env' });
    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes('SECRET=1'));
  });

  it('_expo 아래 번들은 영구 캐시한다', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/_expo/static/js/web/entry-abc123.js',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('/api 밖 응답에만 보안 헤더가 붙는다', async () => {
    for (const url of ['/', '/repo/abc', '/.env']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['referrer-policy'], 'same-origin', url);
    }
    const api = await h.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(api.headers['x-frame-options'], undefined);
  });
});
