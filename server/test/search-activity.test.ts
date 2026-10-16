import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { auth, createHarness, createInvite, createRepo, join, signup, uploadBlob, uploadFile, type Harness, type Session } from './helpers.ts';

describe('파일 찾기', () => {
  let h: Harness;
  let owner: Session;
  let other: Session;
  let repoId: string;
  let secondRepo: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '주인');
    other = await signup(h.app, '남');
    repoId = await createRepo(h.app, owner, '사진첩');
    secondRepo = await createRepo(h.app, owner, '문서');
    await uploadFile(h.app, owner, repoId, '여행/제주/바다.JPG', 'a');
    await uploadFile(h.app, owner, repoId, '여행/서울.jpg', 'b');
    await uploadFile(h.app, owner, repoId, '메모.txt', 'c');
    await uploadFile(h.app, owner, secondRepo, '제주 계획.md', 'd');
    const otherRepo = await createRepo(h.app, other, '남의 것');
    await uploadFile(h.app, other, otherRepo, '제주 비밀.txt', 'e');
  });
  after(async () => {
    await h.close();
  });

  const search = (url: string, session = owner) => h.app.inject({ method: 'GET', url, headers: auth(session) });

  it('이름·경로에 글자가 든 파일을 찾고, 이름에 맞은 것을 앞에 둔다', async () => {
    const res = await search(`/api/repos/${repoId}/search?q=${encodeURIComponent('jpg')}`);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().hits.map((hit: { path: string }) => hit.path).sort(), ['여행/서울.jpg', '여행/제주/바다.JPG']);
    const byPath = await search(`/api/repos/${repoId}/search?q=${encodeURIComponent('제주')}`);
    assert.deepEqual(byPath.json().hits.map((hit: { path: string; nameMatch: boolean }) => [hit.path, hit.nameMatch]), [['여행/제주/바다.JPG', false]]);
  });

  it('분해형 한글(NFD)로 쳐도 찾는다', async () => {
    const res = await search(`/api/repos/${repoId}/search?q=${encodeURIComponent('바다'.normalize('NFD'))}`);
    assert.equal(res.json().hits.length, 1);
  });

  it('내 저장소 전부에서 찾되 남의 저장소는 보지 않는다', async () => {
    const res = await search(`/api/search?q=${encodeURIComponent('제주')}`);
    assert.deepEqual(res.json().hits.map((hit: { repoName: string; path: string }) => `${hit.repoName}/${hit.path}`).sort(), [
      '문서/제주 계획.md',
      '사진첩/여행/제주/바다.JPG',
    ]);
  });

  it('빈 글자는 400, 멤버가 아니면 404, 한도를 넘으면 truncated', async () => {
    assert.equal((await search(`/api/repos/${repoId}/search?q=`)).statusCode, 400);
    assert.equal((await search(`/api/repos/${repoId}/search?q=a`, other)).statusCode, 404);
    const res = await search(`/api/repos/${repoId}/search?q=${encodeURIComponent('여행')}&limit=1`);
    assert.equal(res.json().hits.length, 1);
    assert.equal(res.json().truncated, true);
  });
});

describe('새 소식', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '주인');
    viewer = await signup(h.app, '손');
    repoId = await createRepo(h.app, owner, '동아리');
    await join(h.app, viewer, (await createInvite(h.app, owner, repoId, { role: 'viewer' })).code);
  });
  after(async () => {
    await h.close();
  });

  const activity = (session: Session, since = 0) =>
    h.app.inject({ method: 'GET', url: `/api/activity?since=${since}`, headers: auth(session) });

  it('파일 변경·제안·의견이 시간순으로 오고, 내가 한 일은 mine 이다', async () => {
    await uploadFile(h.app, owner, repoId, 'a.txt', '1');
    const hash = await uploadBlob(h.app, viewer, repoId, 'b.txt', '2');
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(viewer),
      payload: { title: '새 파일', changes: [{ path: 'b.txt', blobHash: hash }] },
    });
    const proposalId = created.json().proposal.id;
    await h.app.inject({ method: 'POST', url: `/api/proposals/${proposalId}/comments`, headers: auth(owner), payload: { body: '좋아요' } });

    const forOwner = (await activity(owner)).json().items;
    assert.deepEqual(forOwner.map((i: { kind: string }) => i.kind), ['comment', 'proposal-opened', 'commit']);
    assert.deepEqual(forOwner.map((i: { mine: boolean }) => i.mine), [true, false, true]);
    assert.equal(forOwner[1].actor.displayName, '손');
    assert.equal(forOwner[1].proposalNumber, 1);

    const forViewer = (await activity(viewer)).json().items;
    assert.deepEqual(forViewer.map((i: { mine: boolean }) => i.mine), [false, true, false]);
  });

  it('반영하면 proposal-merged 로 바뀌고, since 뒤의 것만 온다', async () => {
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const proposalId = (await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/proposals`, headers: auth(owner) })).json().proposals[0].id;
    await h.app.inject({ method: 'POST', url: `/api/proposals/${proposalId}/merge`, headers: auth(owner) });
    const items = (await activity(viewer, before)).json().items;
    // 반영 스냅샷과 제안 상태 변경은 같은 순간이라 순서는 보지 않는다.
    assert.deepEqual(items.map((i: { kind: string }) => i.kind).sort(), ['commit', 'proposal-merged']);
    const merged = items.find((i: { kind: string }) => i.kind === 'proposal-merged');
    assert.equal(merged.mine, false, '내 제안이라도 반영은 남이 한 일');
    assert.equal(merged.actor.displayName, '주인', '반영한 사람이 actor');
  });

  it('멤버가 아닌 저장소의 일은 보이지 않는다', async () => {
    const stranger = await signup(h.app, '모르는 사람');
    assert.equal((await activity(stranger)).json().items.length, 0);
  });
});
