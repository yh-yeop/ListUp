import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import yauzl from 'yauzl';
import { UPLOAD_CHUNK_BYTES } from '@listup/shared';
import { issueDownloadLink } from '../src/lib/download-links.ts';
import { collectGarbage } from '../src/services/gc.ts';
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

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** zip 을 풀어 {이름: 내용} 으로. */
function unzip(buffer: Buffer): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Record<string, Buffer> = {};
      zip.readEntry();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr || !stream) return reject(openErr);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
    });
  });
}

describe('나눠 올리기', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let outsider: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness({ maxStagingBytesPerDay: 1000 });
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '열람자');
    outsider = await signup(h.app, '남');
    repoId = await createRepo(h.app, owner, '전송');
    await join(h.app, viewer, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
  });
  after(async () => {
    await h.close();
  });

  const start = (session: Session, name: string, size: number) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/uploads`, headers: auth(session), payload: { name, size } });
  const put = (session: Session, id: string, offset: number, chunk: Buffer) =>
    h.app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}?offset=${offset}`,
      headers: { ...auth(session), 'content-type': 'application/octet-stream' },
      payload: chunk,
    });
  const complete = (session: Session, id: string) =>
    h.app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers: auth(session) });

  it('조각으로 받아 blob 이 되고, 여러 파일 커밋에 쓸 수 있다', async () => {
    const data = Buffer.from('가'.repeat(5000)); // 15000 바이트
    const created = await start(owner, '큰파일.txt', data.length);
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json().upload;
    assert.equal(session.received, 0);
    assert.equal(session.chunkSize, UPLOAD_CHUNK_BYTES);

    for (const [from, to] of [[0, 6000], [6000, 12000], [12000, data.length]]) {
      const res = await put(owner, session.id, from, data.subarray(from, to));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().upload.received, to);
    }
    const done = await complete(owner, session.id);
    assert.equal(done.statusCode, 201, done.body);
    assert.equal(done.json().blob.hash, sha256(data));
    assert.equal(done.json().blob.mimeType, 'text/plain');

    const commit = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/files/commit`,
      headers: auth(owner),
      payload: { changes: [{ path: '큰파일.txt', blobHash: done.json().blob.hash }] },
    });
    assert.equal(commit.statusCode, 201, commit.body);
    const raw = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('큰파일.txt')}`, headers: auth(owner) });
    assert.equal(raw.body, data.toString());
    // 세션은 끝나면 사라진다.
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: auth(owner) })).statusCode, 404);
  });

  it('끊긴 뒤에는 받은 위치를 물어 이어 보내고, 위치가 어긋나면 409 로 알려준다', async () => {
    const data = Buffer.alloc(3000, 7);
    const session = (await start(owner, 'resume.bin', data.length)).json().upload;
    assert.equal((await put(owner, session.id, 0, data.subarray(0, 1000))).statusCode, 200);

    // 같은 조각을 다시 보내거나(앞선 응답을 못 받음) 건너뛰면 409 와 받은 위치
    const again = await put(owner, session.id, 0, data.subarray(0, 1000));
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.details.received, 1000);
    const skip = await put(owner, session.id, 2000, data.subarray(2000));
    assert.equal(skip.statusCode, 409);

    const status = await h.app.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: auth(owner) });
    assert.equal(status.json().upload.received, 1000);
    assert.equal((await put(owner, session.id, 1000, data.subarray(1000))).statusCode, 200);
    // 다 받기 전에는 완료할 수 없다 → 이제는 된다
    const done = await complete(owner, session.id);
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().blob.hash, sha256(data));
  });

  it('다 받기 전에 완료하면 409, 크기를 넘는 조각은 413', async () => {
    const session = (await start(owner, 'x.bin', 10)).json().upload;
    assert.equal((await complete(owner, session.id)).statusCode, 409);
    assert.equal((await put(owner, session.id, 0, Buffer.alloc(11))).statusCode, 413);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: auth(owner) })).json().upload.received, 0);
  });

  it('빈 파일은 조각 없이 완료된다', async () => {
    const session = (await start(owner, 'empty.txt', 0)).json().upload;
    const done = await complete(owner, session.id);
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().blob.size, 0);
  });

  it('남의 세션은 보이지 않고, 저장소 멤버가 아니면 시작할 수 없다', async () => {
    const session = (await start(owner, 'mine.bin', 5)).json().upload;
    assert.equal((await put(viewer, session.id, 0, Buffer.alloc(5))).statusCode, 404);
    assert.equal((await complete(viewer, session.id)).statusCode, 404);
    assert.equal((await start(outsider, 'a.bin', 5)).statusCode, 404);
  });

  it('한 파일 한도를 넘으면 시작할 때 413', async () => {
    const res = await start(owner, 'huge.bin', h.ctx.config.maxUploadBytes + 1);
    assert.equal(res.statusCode, 413);
  });

  it('열람자는 하루 업로드 한도를 보고, 편집자는 세지 않는다', async () => {
    assert.equal((await start(viewer, 'big.bin', 1001)).statusCode, 413);
    const ok = (await start(viewer, 'ok.bin', 800)).json().upload;
    assert.equal((await put(viewer, ok.id, 0, Buffer.alloc(800, 1))).statusCode, 200);
    assert.equal((await complete(viewer, ok.id)).statusCode, 201);
    assert.equal((await start(viewer, 'more.bin', 300)).statusCode, 413);
    // 편집자(소유자)는 커밋할 수 있으므로 한도를 보지 않는다.
    assert.equal((await start(owner, 'owner.bin', 5000)).statusCode, 201);
  });

  it('오래 멈춘 세션은 GC 가 치운다', async () => {
    const session = (await start(owner, 'stale.bin', 10)).json().upload;
    assert.equal((await put(owner, session.id, 0, Buffer.alloc(4))).statusCode, 200);
    h.ctx.db.prepare(`UPDATE upload_sessions SET updated_at = updated_at - ? WHERE id = ?`).run(48 * 3600 * 1000, session.id);
    const result = await collectGarbage(h.ctx, 24 * 3600 * 1000);
    assert.equal(result.staleUploads, 1);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/uploads/${session.id}`, headers: auth(owner) })).statusCode, 404);
  });

  it('취소하면 세션이 사라진다', async () => {
    const session = (await start(owner, 'cancel.bin', 5)).json().upload;
    const res = await h.app.inject({ method: 'DELETE', url: `/api/uploads/${session.id}`, headers: auth(owner) });
    assert.equal(res.statusCode, 200);
    assert.equal((await put(owner, session.id, 0, Buffer.alloc(5))).statusCode, 404);
  });
});

describe('이어받기와 다운로드 링크', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;
  const content = Buffer.from('0123456789abcdefghij');

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '열람자');
    repoId = await createRepo(h.app, owner, '받기');
    await join(h.app, viewer, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
    await uploadFile(h.app, owner, repoId, '문서/a.txt', content);
    await uploadFile(h.app, owner, repoId, '문서/속/b.txt', 'bee');
    await uploadFile(h.app, owner, repoId, '밖.txt', 'out');
  });
  after(async () => {
    await h.close();
  });

  const raw = (headers: Record<string, string> = {}) =>
    h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('문서/a.txt')}`,
      headers: { ...auth(owner), ...headers },
    });
  const link = (session: Session, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: `/api/repos/${repoId}/download-link`, headers: auth(session), payload });

  it('Range 한 구간은 206, 끝에서 n 바이트도 된다', async () => {
    const full = await raw();
    assert.equal(full.headers['accept-ranges'], 'bytes');
    const part = await raw({ range: 'bytes=5-9' });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, '56789');
    assert.equal(part.headers['content-range'], `bytes 5-9/${content.length}`);
    assert.equal(part.headers['content-length'], '5');
    const open = await raw({ range: 'bytes=15-' });
    assert.equal(open.body, 'fghij');
    const suffix = await raw({ range: 'bytes=-3' });
    assert.equal(suffix.body, 'hij');
  });

  it('범위를 넘으면 416, If-Range 가 다른 내용이면 전체', async () => {
    const bad = await raw({ range: 'bytes=100-' });
    assert.equal(bad.statusCode, 416);
    assert.equal(bad.headers['content-range'], `bytes */${content.length}`);
    const stale = await raw({ range: 'bytes=0-1', 'if-range': '"다른내용"' });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body, content.toString());
    const fresh = await raw({ range: 'bytes=0-1', 'if-range': (await raw()).headers.etag as string });
    assert.equal(fresh.statusCode, 206);
  });

  it('다운로드 링크는 로그인 헤더 없이 받아지고 이어받기도 된다', async () => {
    const res = await link(viewer, { path: '문서/a.txt' });
    assert.equal(res.statusCode, 200, res.body);
    const { url, expiresAt } = res.json();
    assert.match(url, /^\/api\/dl\?t=/);
    assert.ok(expiresAt > Date.now());
    const got = await h.app.inject({ method: 'GET', url });
    assert.equal(got.statusCode, 200);
    assert.equal(got.body, content.toString());
    assert.match(String(got.headers['content-disposition']), /attachment/);
    const part = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=10-' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, 'abcdefghij');
  });

  it('위조·만료된 링크, 없는 파일은 쓸 수 없다', async () => {
    const { url } = (await link(viewer, { path: '문서/a.txt' })).json();
    const tampered = url.slice(0, -2) + (url.endsWith('A') ? 'BB' : 'AA');
    assert.equal((await h.app.inject({ method: 'GET', url: tampered })).statusCode, 404);
    const expired = issueDownloadLink(
      { u: viewer.userId, ep: 0, r: repoId, p: '문서/a.txt', s: null, k: 'file' },
      h.ctx.config.authSecret,
      Date.now() - 60 * 60 * 1000,
    );
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/dl?t=${expired.token}` })).statusCode, 404);
    assert.equal((await link(viewer, { path: '없음.txt' })).statusCode, 404);
    // 로그인 토큰은 링크로 쓸 수 없다
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/dl?t=${viewer.token}` })).statusCode, 404);
  });

  it('비밀번호를 바꾸면 이미 나간 링크도 끊긴다', async () => {
    const someone = await signup(h.app, '바꿀사람');
    await join(h.app, someone, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
    const { url } = (await link(someone, { path: '밖.txt' })).json();
    assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 200);
    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: auth(someone),
      payload: { currentPassword: 'password1234', newPassword: 'another-password-1' },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404);
  });

  it('저장소에서 내보내진 사람의 링크는 쓸 수 없다', async () => {
    const leaver = await signup(h.app, '나갈사람');
    await join(h.app, leaver, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
    const { url } = (await link(leaver, { path: '밖.txt' })).json();
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/members/${leaver.userId}`, headers: auth(owner) });
    assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404);
  });

  it('폴더를 zip 으로 받으면 폴더 이름 아래에 경로 그대로 들어 있다', async () => {
    const res = await link(viewer, { path: '문서', archive: true });
    assert.equal(res.statusCode, 200, res.body);
    const got = await h.app.inject({ method: 'GET', url: res.json().url });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'application/zip');
    assert.equal(Number(got.headers['content-length']), got.rawPayload.length, '전체 크기를 미리 알려준다');
    assert.match(String(got.headers['content-disposition']), /filename\*=UTF-8''%EB%AC%B8%EC%84%9C\.zip/);
    const files = await unzip(got.rawPayload);
    assert.deepEqual(Object.keys(files).sort(), ['문서/a.txt', '문서/속/b.txt']);
    assert.equal(files['문서/a.txt'].toString(), content.toString());
    assert.equal(files['문서/속/b.txt'].toString(), 'bee');
  });

  it('저장소 전체 zip 은 저장소 이름이 맨 위 폴더다. 빈 폴더는 404', async () => {
    const whole = await h.app.inject({ method: 'GET', url: (await link(owner, { path: '', archive: true })).json().url });
    const files = await unzip(whole.rawPayload);
    assert.deepEqual(Object.keys(files).sort(), ['받기/문서/a.txt', '받기/문서/속/b.txt', '받기/밖.txt']);
    assert.equal((await link(owner, { path: '없는폴더', archive: true })).statusCode, 404);
  });
});
