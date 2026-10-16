import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseMirrorLink } from '../src/services/mirror.ts';
import { auth, createHarness, createRepo, signup, uploadFile, type Harness, type Session } from './helpers.ts';

describe('서버 간 따라가기', () => {
  let source: Harness;
  let follower: Harness;
  let sourceUrl: string;
  let alice: Session;
  let bob: Session;
  let sourceRepo: string;
  let link: string;
  let shareId: string;
  let mirrorRepo: string;

  before(async () => {
    source = await createHarness();
    follower = await createHarness();
    await source.app.listen({ host: '127.0.0.1', port: 0 });
    const address = source.app.server.address() as { port: number };
    sourceUrl = `http://127.0.0.1:${address.port}`;
    alice = await signup(source.app, '앨리스');
    bob = await signup(follower.app, '밥');
    sourceRepo = await createRepo(source.app, alice, '음악');
    await uploadFile(source.app, alice, sourceRepo, '앨범/1.mp3', '노래1');
    await uploadFile(source.app, alice, sourceRepo, '앨범/2.mp3', '노래2');
    const share = await source.app.inject({
      method: 'POST',
      url: `/api/repos/${sourceRepo}/shares`,
      headers: auth(alice),
      payload: { kind: 'mirror' },
    });
    link = `${sourceUrl}/s/${share.json().share.token}`;
    shareId = share.json().share.id;
  });
  after(async () => {
    await source.close();
    await follower.close();
  });

  const repoSummary = async () =>
    (await follower.app.inject({ method: 'GET', url: `/api/repos/${mirrorRepo}`, headers: auth(bob) })).json().repo;
  const raw = async (path: string) =>
    (await follower.app.inject({ method: 'GET', url: `/api/repos/${mirrorRepo}/raw?path=${encodeURIComponent(path)}`, headers: auth(bob) }));
  const sync = () => follower.app.inject({ method: 'POST', url: `/api/repos/${mirrorRepo}/mirror/sync`, headers: auth(bob) });

  async function waitIdle() {
    for (let i = 0; i < 100; i += 1) {
      const repo = await repoSummary();
      if (!repo.mirror.syncing && repo.mirror.lastSyncedAt) return repo;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('미러 가져오기가 끝나지 않았습니다');
  }

  it('링크 모양을 알아본다', () => {
    assert.deepEqual(parseMirrorLink('https://a.example/s/abcdefghijklmnopqrstuvwx'), {
      sourceUrl: 'https://a.example',
      token: 'abcdefghijklmnopqrstuvwx',
    });
    assert.deepEqual(parseMirrorLink('http://10.0.0.2:4000/listup/s/abcdefghijklmnopqrstuvwx/'), {
      sourceUrl: 'http://10.0.0.2:4000/listup',
      token: 'abcdefghijklmnopqrstuvwx',
    });
    assert.equal(parseMirrorLink('ftp://a/s/abcdefghijklmnopqrstuvwx'), null);
    assert.equal(parseMirrorLink('https://a/x/abcdefghijklmnopqrstuvwx'), null);
  });

  it('따라가기 링크로 미러 저장소를 만들고 원본의 파일을 가져온다', async () => {
    const res = await follower.app.inject({ method: 'POST', url: '/api/repos/mirror', headers: auth(bob), payload: { link } });
    assert.equal(res.statusCode, 201, res.body);
    mirrorRepo = res.json().repo.id;
    assert.equal(res.json().repo.name, '음악');
    assert.equal(res.json().repo.mirror.sourceUrl, sourceUrl);
    const repo = await waitIdle();
    assert.equal(repo.mirror.lastError, null);
    assert.equal(repo.fileCount, 2);
    assert.equal((await raw('앨범/1.mp3')).body, '노래1');
  });

  it('미러 저장소는 여기서 바꿀 수 없다', async () => {
    const res = await uploadFile(follower.app, bob, mirrorRepo, 'x.txt', 'x');
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /따라가는 저장소/);
    const dup = await follower.app.inject({ method: 'POST', url: '/api/repos/mirror', headers: auth(bob), payload: { link } });
    assert.equal(dup.statusCode, 409, '같은 키를 두 번 따라가지 않는다');
  });

  it('원본이 바뀌면 바뀐 것만 가져온다', async () => {
    await uploadFile(source.app, alice, sourceRepo, '앨범/3.mp3', '노래3');
    await source.app.inject({ method: 'DELETE', url: `/api/repos/${sourceRepo}/files?path=${encodeURIComponent('앨범/1.mp3')}`, headers: auth(alice) });
    const res = await sync();
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().result, { changed: true, fetched: 1, fetchedBytes: Buffer.byteLength('노래3') });
    assert.equal((await raw('앨범/3.mp3')).body, '노래3');
    assert.equal((await raw('앨범/1.mp3')).statusCode, 404);

    const again = await sync();
    assert.deepEqual(again.json().result, { changed: false, fetched: 0, fetchedBytes: 0 });
  });

  it('원본이 키를 회수하면 실패를 남기고, 그래도 사본은 볼 수 있다', async () => {
    await source.app.inject({ method: 'DELETE', url: `/api/shares/${shareId}`, headers: auth(alice) });
    const res = await sync();
    assert.equal(res.statusCode, 400);
    const repo = await repoSummary();
    assert.match(repo.mirror.lastError, /닿지 못했거나/);
    assert.equal((await raw('앨범/2.mp3')).body, '노래2');
  });

  it('따라가기를 그만두면 보통 저장소가 된다', async () => {
    const res = await follower.app.inject({ method: 'DELETE', url: `/api/repos/${mirrorRepo}/mirror`, headers: auth(bob) });
    assert.equal(res.json().repo.mirror, null);
    assert.equal((await uploadFile(follower.app, bob, mirrorRepo, 'x.txt', 'x')).statusCode, 201);
  });

  it('틀린 링크·닿지 않는 서버는 400 이고 이유를 자세히 말하지 않는다', async () => {
    const bad = await follower.app.inject({ method: 'POST', url: '/api/repos/mirror', headers: auth(bob), payload: { link: 'hello' } });
    assert.equal(bad.statusCode, 400);
    const dead = await follower.app.inject({
      method: 'POST',
      url: '/api/repos/mirror',
      headers: auth(bob),
      payload: { link: 'http://127.0.0.1:9/s/abcdefghijklmnopqrstuvwx' },
    });
    assert.equal(dead.statusCode, 400);
    assert.match(dead.json().error.message, /닿지 못했거나/);
  });
});
