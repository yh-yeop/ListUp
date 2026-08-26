import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

  it('한도를 넘는 파일은 413 이고 아무것도 커밋되지 않는다', async () => {
    const before = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    const headBefore = before.json().repo.headSnapshotId;

    // 하네스 한도는 5MB. multipart 는 한도에서 스트림을 조용히 자르므로 잘린 채 커밋되면 안 된다.
    const res = await uploadFile(h.app, owner, repoId, '큰파일.bin', Buffer.alloc(6 * 1024 * 1024, 1));
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, 'payload_too_large');

    const tree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files`,
      headers: auth(owner),
    });
    assert.equal(
      (tree.json().tree as TreeListing).files.some((f) => f.name === '큰파일.bin'),
      false,
    );
    const after = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    assert.equal(after.json().repo.headSnapshotId, headBefore);

    // 임시 파일도 남지 않는다.
    const tmpDir = path.join(h.dir, 'blobs', 'tmp');
    const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((n) => n.startsWith('up_')) : [];
    assert.deepEqual(leftovers, []);
  });

  it('업로드 중 다른 커밋이 끼어들어도 그 파일이 사라지지 않는다', async () => {
    const original = h.ctx.blobs.writeStream.bind(h.ctx.blobs);
    let interleaved = false;
    h.ctx.blobs.writeStream = async (stream, maxBytes) => {
      if (!interleaved) {
        interleaved = true;
        // 첫 업로드가 스트림을 받는 동안 다른 업로드가 먼저 커밋되는 상황.
        const other = await uploadFile(h.app, owner, repoId, '동시/둘째.txt', '둘째');
        assert.equal(other.statusCode, 201);
      }
      return original(stream, maxBytes);
    };
    try {
      const res = await uploadFile(h.app, owner, repoId, '동시/첫째.txt', '첫째');
      assert.equal(res.statusCode, 201);
    } finally {
      h.ctx.blobs.writeStream = original;
    }
    assert.equal(interleaved, true);

    const tree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('동시')}`,
      headers: auth(owner),
    });
    const names = (tree.json().tree as TreeListing).files.map((f) => f.name).sort();
    assert.deepEqual(names, ['둘째.txt', '첫째.txt'].sort());
  });

  it('다운로드에 ETag 가 붙고 If-None-Match 가 맞으면 304 다', async () => {
    const up = await uploadFile(h.app, owner, repoId, '캐시/노트.txt', '버전 1');
    assert.equal(up.statusCode, 201);
    const hash = up.json().file.blobHash as string;
    const url = `/api/repos/${repoId}/raw?path=${encodeURIComponent('캐시/노트.txt')}`;

    const res = await h.app.inject({ method: 'GET', url, headers: auth(owner) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.etag, `"${hash}"`);
    // head 기준 URL 은 같은 경로에 새 내용이 올라올 수 있으니 매번 재검증한다.
    assert.equal(res.headers['cache-control'], 'private, no-cache');

    const cached = await h.app.inject({
      method: 'GET',
      url,
      headers: { ...auth(owner), 'if-none-match': `"${hash}"` },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');

    const weak = await h.app.inject({
      method: 'GET',
      url,
      headers: { ...auth(owner), 'if-none-match': `W/"${hash}"` },
    });
    assert.equal(weak.statusCode, 304);

    // 같은 경로에 다른 내용을 올리면 ETag 가 바뀌고, 옛 태그로는 새 내용을 받는다.
    const up2 = await uploadFile(h.app, owner, repoId, '캐시/노트.txt', '버전 2');
    const hash2 = up2.json().file.blobHash as string;
    assert.notEqual(hash2, hash);
    const fresh = await h.app.inject({
      method: 'GET',
      url,
      headers: { ...auth(owner), 'if-none-match': `"${hash}"` },
    });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.headers.etag, `"${hash2}"`);
    assert.equal(fresh.body, '버전 2');

    // 스냅샷을 지정한 URL 은 내용이 고정이라 오래 캐시해도 된다.
    const pinned = await h.app.inject({
      method: 'GET',
      url: `${url}&snapshot=${up2.json().snapshotId}`,
      headers: auth(owner),
    });
    assert.equal(pinned.statusCode, 200);
    assert.equal(pinned.headers['cache-control'], 'private, max-age=31536000, immutable');
  });

  it('HEAD 요청은 본문 없이 헤더만 준다', async () => {
    const res = await h.app.inject({
      method: 'HEAD',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('캐시/노트.txt')}`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength('버전 2')));
    assert.match(String(res.headers.etag), /^"[0-9a-f]{64}"$/);
    assert.equal(res.body, '');
  });

  it('파일이 있는 이름 아래에는 파일을 만들 수 없다', async () => {
    const file = await uploadFile(h.app, owner, repoId, '겹침/이름', '파일');
    assert.equal(file.statusCode, 201);
    const res = await uploadFile(h.app, owner, repoId, '겹침/이름/안.txt', 'x');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'conflict');
    assert.match(res.json().error.message, /상위 경로에 파일이 있습니다/);
  });

  it('폴더가 있는 이름으로는 파일을 만들 수 없다', async () => {
    const inner = await uploadFile(h.app, owner, repoId, '겹침/폴더/안.txt', 'x');
    assert.equal(inner.statusCode, 201);
    const res = await uploadFile(h.app, owner, repoId, '겹침/폴더', '파일');
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /같은 이름의 폴더가 이미 있습니다/);
  });

  it('이동할 때도 파일과 폴더 이름이 겹치면 거부한다', async () => {
    const move = (from: string, to: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/repos/${repoId}/files/move`,
        headers: auth(owner),
        payload: { from, to },
      });

    // 파일을 기존 폴더 이름으로
    const ontoFolder = await move('겹침/이름', '겹침/폴더');
    assert.equal(ontoFolder.statusCode, 409);
    assert.match(ontoFolder.json().error.message, /같은 이름의 폴더가 이미 있습니다/);

    // 폴더를 기존 파일 아래로
    const underFile = await move('겹침/폴더', '겹침/이름/하위');
    assert.equal(underFile.statusCode, 409);
    assert.match(underFile.json().error.message, /상위 경로에 파일이 있습니다/);

    // 폴더의 유일한 파일을 폴더 이름 자리로 옮기면 폴더가 사라지므로 겹치지 않는다.
    const collapse = await move('겹침/폴더/안.txt', '겹침/폴더');
    assert.equal(collapse.statusCode, 200);
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('겹침/폴더')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, 'x');
  });

  it('NFD 로 올린 한글 경로도 NFC 로 저장되고 조회된다', async () => {
    const nfc = '정규화/한글.txt';
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfd, nfc);

    const res = await uploadFile(h.app, owner, repoId, nfd, '내용');
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().file.path, nfc);

    const tree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('정규화')}`,
      headers: auth(owner),
    });
    assert.deepEqual(
      (tree.json().tree as TreeListing).files.map((f) => f.name),
      ['한글.txt'],
    );

    const raw = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent(nfc)}`,
      headers: auth(owner),
    });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.body, '내용');
  });

  it('제로폭 문자가 든 경로는 거부한다', async () => {
    const res = await uploadFile(h.app, owner, repoId, '보이지\u200B않음.txt', 'x');
    assert.equal(res.statusCode, 400);

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('a\u200Bb.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.statusCode, 400);
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

  it("RFC 8187 이 금지한 '()* 도 filename* 에서 퍼센트 인코딩한다", () => {
    const header = contentDisposition("a'b(c)*.txt", false);
    const encoded = header.split("filename*=UTF-8''")[1];
    assert.equal(encoded, 'a%27b%28c%29%2A.txt');
  });
});
