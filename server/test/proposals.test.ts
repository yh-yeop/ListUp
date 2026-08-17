import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ProposalDetail } from '@listup/shared';
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

async function createProposal(
  h: Harness,
  session: Session,
  repoId: string,
  payload: Record<string, unknown>,
) {
  return h.app.inject({
    method: 'POST',
    url: `/api/repos/${repoId}/proposals`,
    headers: auth(session),
    payload,
  });
}

describe('변경 제안', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  beforeEach(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '기여자');
    repoId = await createRepo(h.app, owner, '문서함');
    await uploadFile(h.app, owner, repoId, '보고서.txt', '원본 내용');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);
  });

  after(async () => {
    await h?.close();
  });

  it('열람 권한만 있어도 제안을 올릴 수 있다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const res = await createProposal(h, viewer, repoId, {
      title: '오타 수정',
      description: '3번째 줄을 고쳤습니다.',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    assert.equal(res.statusCode, 201);

    const proposal = res.json().proposal as ProposalDetail;
    assert.equal(proposal.number, 1);
    assert.equal(proposal.status, 'open');
    assert.equal(proposal.author.displayName, '기여자');
    assert.equal(proposal.changes.length, 1);
    assert.equal(proposal.changes[0].op, 'update');
    assert.equal(proposal.changes[0].baseBlobHash !== null, true);
    assert.equal(proposal.mergeable, true);
  });

  it('제안만으로는 저장소가 바뀌지 않는다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, '원본 내용');
  });

  it('제안한 파일 내용을 병합 전에 확인할 수 있다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;

    const preview = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.body, '고친 내용');
  });

  it('편집자가 병합하면 저장소에 반영된다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;

    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 200);
    assert.equal(merged.json().proposal.status, 'merged');

    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, '고친 내용');
  });

  it('제안자는 스스로 병합할 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${created.json().proposal.id}/merge`,
      headers: auth(viewer),
    });
    assert.equal(res.statusCode, 403);
  });

  it('제안 이후 같은 파일이 바뀌면 충돌로 막는다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '기여자의 수정');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;

    // 소유자가 먼저 같은 파일을 직접 바꾼다.
    await uploadFile(h.app, owner, repoId, '보고서.txt', '소유자의 수정');

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(owner),
    });
    const proposal = detail.json().proposal as ProposalDetail;
    assert.equal(proposal.mergeable, false);
    assert.deepEqual(proposal.conflicts, ['보고서.txt']);

    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 409);
    assert.deepEqual(merged.json().error.details.conflicts, ['보고서.txt']);

    // 막혔으니 소유자의 내용이 그대로 남아 있어야 한다.
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, '소유자의 수정');
  });

  it('다른 파일이 바뀐 것은 충돌이 아니다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '기여자의 수정');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });

    await uploadFile(h.app, owner, repoId, '다른파일.txt', '상관없는 변경');

    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${created.json().proposal.id}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 200);

    // 병합해도 다른 파일은 그대로 남는다.
    const other = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('다른파일.txt')}`,
      headers: auth(owner),
    });
    assert.equal(other.body, '상관없는 변경');
  });

  it('추가와 삭제를 한 제안에 담을 수 있다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '새파일.txt', '새 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '정리',
      changes: [
        { path: '자료/새파일.txt', blobHash: hash },
        { path: '보고서.txt', blobHash: null },
      ],
    });
    assert.equal(created.statusCode, 201);
    const proposal = created.json().proposal as ProposalDetail;
    const ops = Object.fromEntries(proposal.changes.map((c) => [c.path, c.op]));
    assert.equal(ops['자료/새파일.txt'], 'add');
    assert.equal(ops['보고서.txt'], 'delete');

    await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/merge`,
      headers: auth(owner),
    });

    const added = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('자료/새파일.txt')}`,
      headers: auth(owner),
    });
    assert.equal(added.body, '새 내용');

    const deleted = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(deleted.statusCode, 404);
  });

  it('올리지 않은 blob 은 참조할 수 없다', async () => {
    const res = await createProposal(h, viewer, repoId, {
      title: '가짜',
      changes: [{ path: 'x.txt', blobHash: 'a'.repeat(64) }],
    });
    assert.equal(res.statusCode, 400);
  });

  it('내용이 같으면 제안을 만들 수 없다', async () => {
    const sameHash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '원본 내용');
    const res = await createProposal(h, viewer, repoId, {
      title: '변경 없음',
      changes: [{ path: '보고서.txt', blobHash: sameHash }],
    });
    assert.equal(res.statusCode, 400);
  });

  it('없는 파일은 삭제 제안할 수 없다', async () => {
    const res = await createProposal(h, viewer, repoId, {
      title: '헛된 삭제',
      changes: [{ path: '없는파일.txt', blobHash: null }],
    });
    assert.equal(res.statusCode, 400);
  });

  it('빈 제안은 만들 수 없다', async () => {
    const res = await createProposal(h, viewer, repoId, { title: '빈 제안', changes: [] });
    assert.equal(res.statusCode, 400);
  });

  it('닫은 제안은 병합되지 않고, 다시 열 수 있다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;

    const closed = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/close`,
      headers: auth(viewer),
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().proposal.status, 'closed');

    const merge = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merge.statusCode, 409);

    const reopened = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/reopen`,
      headers: auth(viewer),
    });
    assert.equal(reopened.json().proposal.status, 'open');
  });

  it('두 번 병합할 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;
    const url = `/api/proposals/${proposalId}/merge`;

    assert.equal((await h.app.inject({ method: 'POST', url, headers: auth(owner) })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'POST', url, headers: auth(owner) })).statusCode, 409);
  });

  it('댓글로 논의할 수 있다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/comments`,
      headers: auth(owner),
      payload: { body: '확인했습니다. 반영할게요.' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().comments.length, 1);
    assert.equal(res.json().comments[0].author.displayName, '소유자');
  });

  it('멤버가 아니면 제안을 볼 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const outsider = await signup(h.app, '외부인');

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${created.json().proposal.id}`,
      headers: auth(outsider),
    });
    assert.equal(res.statusCode, 404);
  });

  it('멤버가 아니면 blob 을 올릴 수 없다', async () => {
    const outsider = await signup(h.app, '외부인2');
    await assert.rejects(() => uploadBlob(h.app, outsider, repoId, 'x.txt', 'x'));
  });

  it('제안 번호는 저장소별로 1부터 순서대로 붙는다', async () => {
    const first = await uploadBlob(h.app, viewer, repoId, 'a.txt', 'a');
    const second = await uploadBlob(h.app, viewer, repoId, 'b.txt', 'b');
    const p1 = await createProposal(h, viewer, repoId, {
      title: '첫째',
      changes: [{ path: 'a.txt', blobHash: first }],
    });
    const p2 = await createProposal(h, viewer, repoId, {
      title: '둘째',
      changes: [{ path: 'b.txt', blobHash: second }],
    });
    assert.equal(p1.json().proposal.number, 1);
    assert.equal(p2.json().proposal.number, 2);

    const otherRepo = await createRepo(h.app, owner, '다른 저장소');
    const otherBlob = await uploadBlob(h.app, owner, otherRepo, 'c.txt', 'c');
    const p3 = await createProposal(h, owner, otherRepo, {
      title: '다른 저장소 첫 제안',
      changes: [{ path: 'c.txt', blobHash: otherBlob }],
    });
    assert.equal(p3.json().proposal.number, 1);
  });
});

describe('제안 목록 필터', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '필터 테스트');

    const openBlob = await uploadBlob(h.app, owner, repoId, 'open.txt', 'open');
    await createProposal(h, owner, repoId, {
      title: '열린 제안',
      changes: [{ path: 'open.txt', blobHash: openBlob }],
    });

    const mergedBlob = await uploadBlob(h.app, owner, repoId, 'merged.txt', 'merged');
    const toMerge = await createProposal(h, owner, repoId, {
      title: '병합될 제안',
      changes: [{ path: 'merged.txt', blobHash: mergedBlob }],
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${toMerge.json().proposal.id}/merge`,
      headers: auth(owner),
    });
  });
  after(async () => {
    await h.close();
  });

  it('status 로 걸러 볼 수 있다', async () => {
    const openOnly = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/proposals?status=open`,
      headers: auth(owner),
    });
    assert.equal(openOnly.json().proposals.length, 1);
    assert.equal(openOnly.json().proposals[0].title, '열린 제안');

    const all = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(owner),
    });
    assert.equal(all.json().proposals.length, 2);

    const bad = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/proposals?status=nope`,
      headers: auth(owner),
    });
    assert.equal(bad.statusCode, 400);
  });

  it('저장소 요약에 열린 제안 개수가 들어간다', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    assert.equal(res.json().repo.openProposalCount, 1);
  });
});
