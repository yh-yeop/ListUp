import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { maskUrl } from '../src/start.ts';
import { auth, createHarness, createInvite, createRepo, join, signup, uploadFile, type Harness, type Session } from './helpers.ts';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('공개 링크', () => {
  let h: Harness;
  let owner: Session;
  let editor: Session;
  let viewer: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    editor = await signup(h.app, '편집자');
    viewer = await signup(h.app, '열람자');
    repoId = await createRepo(h.app, owner, '가족 사진');
    await join(h.app, editor, (await createInvite(h.app, owner, repoId, { role: 'editor' })).code);
    await join(h.app, viewer, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
    await uploadFile(h.app, owner, repoId, '여행/1.jpg', '사진1');
    await uploadFile(h.app, owner, repoId, '여행/밤/2.jpg', '사진2');
    await uploadFile(h.app, owner, repoId, '비밀.txt', '비밀');
  });
  after(async () => {
    await h.close();
  });

  const make = (session: Session, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/shares`, headers: auth(session), payload });
  const pub = (method: 'GET' | 'POST' | 'PUT' | 'HEAD', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url: `/api/s/${url}`, payload: payload as never, headers });

  it('받기 링크 — 로그인 없이 폴더 목록과 파일을 받고, 폴더 밖은 받지 못한다', async () => {
    const res = await make(editor, { kind: 'download', path: '여행', label: '여행 사진' });
    assert.equal(res.statusCode, 201, res.body);
    const share = res.json().share;
    assert.equal(share.active, true);
    assert.ok(share.expiresAt > Date.now(), '기본 7일');

    const info = await pub('GET', share.token);
    assert.equal(info.statusCode, 200, info.body);
    assert.deepEqual(info.json().share.files.map((f: { path: string }) => f.path), ['1.jpg', '밤/2.jpg']);
    assert.equal(info.json().share.name, '여행');
    assert.equal(JSON.stringify(info.json()).includes('비밀'), false);

    const file = await pub('GET', `${share.token}/raw?path=${encodeURIComponent('밤/2.jpg')}`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.body, '사진2');
    const escape = await pub('GET', `${share.token}/raw?path=${encodeURIComponent('../비밀.txt')}`);
    assert.notEqual(escape.statusCode, 200);

    const zip = await pub('GET', `${share.token}/zip`);
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.headers['content-type'], 'application/zip');
  });

  it('횟수 한도 — 다 쓰면 409, If-Range 로 밝힌 이어받기만 세지 않는다', async () => {
    const share = (await make(owner, { kind: 'download', path: '비밀.txt', maxUses: 1 })).json().share;
    const first = await pub('GET', `${share.token}/raw`);
    assert.equal(first.statusCode, 200);
    const resume = await pub('GET', `${share.token}/raw`, undefined, { range: 'bytes=3-', 'if-range': first.headers.etag as string });
    assert.equal(resume.statusCode, 206, '같은 내용의 이어받기는 횟수를 쓰지 않는다');
    const used = await pub('GET', `${share.token}/raw`);
    assert.equal(used.statusCode, 409);
    assert.match(used.json().error.message, /횟수/);
  });

  it('열람자는 링크를 만들 수 없고, 회수하면 쓸 수 없다', async () => {
    assert.equal((await make(viewer, { kind: 'download', path: '여행' })).statusCode, 403);
    const share = (await make(editor, { kind: 'download', path: '여행' })).json().share;
    const revoked = await h.app.inject({ method: 'DELETE', url: `/api/shares/${share.id}`, headers: auth(editor) });
    assert.equal(revoked.json().share.active, false);
    assert.equal((await pub('GET', share.token)).statusCode, 409);
    assert.equal((await pub('GET', 'x'.repeat(24))).statusCode, 404);
  });

  it('받기 함 — 계정 없이 올리고 보내면 변경 제안이 되고, 같은 이름은 덮어쓰지 않는다', async () => {
    const share = (await make(editor, { kind: 'upload', path: '여행', label: '모임 사진 받기', maxMb: 1 })).json().share;
    const info = (await pub('GET', share.token)).json().share;
    assert.equal(info.kind, 'upload');
    assert.equal(info.remainingBytes, 1024 * 1024);

    const blobs: string[] = [];
    for (const [name, content] of [['1.jpg', '손님 사진'], ['새.jpg', '새 사진']] as const) {
      const data = Buffer.from(content);
      const started = await pub('POST', `${share.token}/uploads`, { name, size: data.length, hash: sha256(data) });
      assert.equal(started.statusCode, 201, started.body);
      const id = started.json().upload.id;
      const put = await pub('PUT', `${share.token}/uploads/${id}?offset=0`, data, { 'content-type': 'application/octet-stream' });
      assert.equal(put.statusCode, 200, put.body);
      const done = await pub('POST', `${share.token}/uploads/${id}/complete`);
      assert.equal(done.statusCode, 201, done.body);
      blobs.push(done.json().blob.hash);
    }
    const sent = await pub('POST', `${share.token}/submit`, {
      name: '이웃 김씨',
      message: '어제 모임 사진입니다',
      files: [
        { path: '1.jpg', blobHash: blobs[0] },
        { path: '새.jpg', blobHash: blobs[1] },
      ],
    });
    assert.equal(sent.statusCode, 201, sent.body);
    assert.deepEqual(sent.json().files, ['1 (1).jpg', '새.jpg'], '이미 있는 이름은 바꿔서 더한다');

    const list = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/proposals`, headers: auth(owner) });
    const proposal = list.json().proposals[0];
    assert.equal(proposal.guestName, '이웃 김씨');
    assert.match(proposal.title, /모임 사진 받기 — 이웃 김씨 님이 2개 보냄/);
    const merged = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/merge`, headers: auth(owner) });
    assert.equal(merged.statusCode, 200, merged.body);
    const raw = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('여행/1.jpg')}`, headers: auth(owner) });
    assert.equal(raw.body, '사진1', '원래 파일은 그대로');
  });

  it('받기 함 — 용량을 넘으면 413, 손님은 해시로 저장소 내용을 떠보지 못한다', async () => {
    const share = (await make(editor, { kind: 'upload', maxMb: 1 })).json().share;
    const big = await pub('POST', `${share.token}/uploads`, { name: 'big.bin', size: 2 * 1024 * 1024 });
    assert.equal(big.statusCode, 413);
    // 저장소에 있는 "사진1" 의 해시를 보내도 즉시 끝나지 않는다 — 새로 보내야 한다.
    const probe = await pub('POST', `${share.token}/uploads`, { name: 'x', size: 7, hash: sha256(Buffer.from('사진1')) });
    assert.equal(probe.statusCode, 201);
    assert.ok(probe.json().upload);
    // 보낼 때도 이 링크로 올린 내용만 — 저장소에 있는 해시를 그냥 적어 내면 거절한다(이유는 하나로).
    const forged = await pub('POST', `${share.token}/submit`, {
      name: '손님',
      files: [{ path: 'x.txt', blobHash: sha256(Buffer.from('사진1')) }],
    });
    assert.equal(forged.statusCode, 400);
    assert.match(forged.json().error.message, /이 받기 함으로 올린 파일이 아닙니다/);
    const unknown = await pub('POST', `${share.token}/submit`, { name: '손님', files: [{ path: 'x.txt', blobHash: '0'.repeat(64) }] });
    assert.equal(unknown.json().error.message, forged.json().error.message, '없는 해시와 남의 해시를 가르지 않는다');
  });

  it('받기 함 — 열어 둔 세션도 남은 용량에서 빼고, 열 수 있는 수에 한도가 있다', async () => {
    const share = (await make(editor, { kind: 'upload', maxMb: 1 })).json().share;
    const half = 600 * 1024;
    assert.equal((await pub('POST', `${share.token}/uploads`, { name: 'a', size: half })).statusCode, 201);
    const second = await pub('POST', `${share.token}/uploads`, { name: 'b', size: half });
    assert.equal(second.statusCode, 413, '열어 둔 세션의 크기도 센다');
    for (let i = 0; i < 9; i += 1) assert.equal((await pub('POST', `${share.token}/uploads`, { name: `s${i}`, size: 1 })).statusCode, 201);
    assert.equal((await pub('POST', `${share.token}/uploads`, { name: 'one-more', size: 1 })).statusCode, 409, '11번째 세션은 막는다');
    // 회수하면 세션도 치운다.
    await h.app.inject({ method: 'DELETE', url: `/api/shares/${share.id}`, headers: auth(editor) });
    const left = h.ctx.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE share_id = ?').get(share.id) as { n: number };
    assert.equal(left.n, 0);
  });

  it('받기 함은 폴더에만 — 파일 경로에는 만들 수 없다', async () => {
    assert.equal((await make(editor, { kind: 'upload', path: '비밀.txt' })).statusCode, 400);
  });

  it('따라가기 키 — 소유자만, 지금 모습과 지금 파일 내용만 준다', async () => {
    assert.equal((await make(editor, { kind: 'mirror' })).statusCode, 403);
    const share = (await make(owner, { kind: 'mirror' })).json().share;
    assert.equal(share.expiresAt, null, '따라가기 키는 기한이 없다');
    assert.equal((await pub('GET', share.token)).statusCode, 404, '사람이 보는 링크가 아니다');
    const manifest = (await pub('GET', `${share.token}/mirror`)).json();
    assert.equal(manifest.repo.name, '가족 사진');
    const one = manifest.files.find((f: { path: string }) => f.path === '여행/1.jpg');
    const blob = await pub('GET', `${share.token}/mirror/blobs/${one.blobHash}`);
    assert.equal(blob.body, '사진1');
    assert.equal((await pub('GET', `${share.token}/mirror/blobs/${'0'.repeat(64)}`)).statusCode, 404);
    const editorList = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/shares`, headers: auth(editor) });
    assert.ok(editorList.json().shares.every((s: { kind: string }) => s.kind !== 'mirror'), '편집자에게는 따라가기 키를 보이지 않는다');
  });

  it('토큰은 로그에 남기지 않는다 — API 경로도, 사람에게 주는 링크도', () => {
    assert.equal(maskUrl('/api/s/abcDEF123_-xyz456789012/raw?path=a'), '/api/s/***/raw?path=a');
    assert.equal(maskUrl('/s/abcDEF123_-xyz456789012'), '/s/***');
  });
});
