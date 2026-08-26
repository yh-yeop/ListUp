import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ProposalDetail } from '@listup/shared';
import { MAX_FILES_PER_REPO } from '@listup/shared';
import {
  auth,
  createHarness,
  createInvite,
  createRepo,
  join,
  multipart,
  signup,
  uploadBlob,
  uploadFile,
  type Harness,
  type Session,
} from './helpers.ts';
import { getRepoRow } from '../src/services/repos.ts';
import { readManifest, writeSnapshot } from '../src/services/snapshots.ts';

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

  // 테스트마다 새 하네스를 만들므로 매번 닫아야 임시 디렉터리와 DB 핸들이 새지 않는다.
  afterEach(async () => {
    await h.close();
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

  it('다른 저장소에 올린 blob 은 제안에 담을 수 없다', async () => {
    // 기여자가 자기 저장소 B 에 올린 blob 의 해시를 A 의 제안에 끼워 넣는다.
    const otherRepo = await createRepo(h.app, viewer, '기여자의 저장소');
    const foreign = await uploadBlob(h.app, viewer, otherRepo, '비밀.txt', '남의 저장소 내용');
    const res = await createProposal(h, viewer, repoId, {
      title: '남의 blob',
      changes: [{ path: '비밀.txt', blobHash: foreign }],
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /이 저장소에 올린 파일만/);

    // 같은 내용이라도 A 에 직접 올리면 된다.
    const own = await uploadBlob(h.app, viewer, repoId, '비밀.txt', '남의 저장소 내용');
    assert.equal(own, foreign);
    const ok = await createProposal(h, viewer, repoId, {
      title: '내 blob',
      changes: [{ path: '비밀.txt', blobHash: own }],
    });
    assert.equal(ok.statusCode, 201);
  });

  it('이 저장소의 이전 스냅샷에 있던 blob 은 다시 살릴 수 있다', async () => {
    const tree = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/files`,
      headers: auth(owner),
    });
    const originalHash = tree.json().tree.files[0].blobHash as string;

    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/files?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(removed.statusCode, 200);

    // repo_blobs 가 생기기 전 데이터처럼 업로드 기록이 없어도, 이 저장소의 스냅샷이 참조했으면 된다.
    h.ctx.db.prepare(`DELETE FROM repo_blobs WHERE repo_id = ?`).run(repoId);

    const res = await createProposal(h, viewer, repoId, {
      title: '되살리기',
      changes: [{ path: '보고서.txt', blobHash: originalHash }],
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().proposal.changes[0].op, 'add');

    await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${res.json().proposal.id}/merge`,
      headers: auth(owner),
    });
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/raw?path=${encodeURIComponent('보고서.txt')}`,
      headers: auth(owner),
    });
    assert.equal(read.body, '원본 내용');
  });

  it('제안 안에서 파일과 폴더 이름이 겹치면 400 이다', async () => {
    const a = await uploadBlob(h.app, viewer, repoId, 'a.txt', 'a');
    const b = await uploadBlob(h.app, viewer, repoId, 'b.txt', 'b');
    const res = await createProposal(h, viewer, repoId, {
      title: '겹침',
      changes: [
        { path: '문서', blobHash: a },
        { path: '문서/안.txt', blobHash: b },
      ],
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /경로가 겹칩니다/);
  });

  it('기존 파일·폴더와 이름이 겹치는 추가 제안은 409 다', async () => {
    await uploadFile(h.app, owner, repoId, '자료/표.csv', 'x');
    const hash = await uploadBlob(h.app, viewer, repoId, 'x.txt', '겹치는 내용');

    // 파일 "보고서.txt" 아래에 파일을 만들려는 경우
    const underFile = await createProposal(h, viewer, repoId, {
      title: '파일 아래',
      changes: [{ path: '보고서.txt/안.txt', blobHash: hash }],
    });
    assert.equal(underFile.statusCode, 409);
    assert.equal(underFile.json().error.code, 'conflict');
    assert.deepEqual(underFile.json().error.details.conflicts, ['보고서.txt/안.txt']);

    // 폴더 "자료" 의 이름으로 파일을 만들려는 경우
    const ontoFolder = await createProposal(h, viewer, repoId, {
      title: '폴더 이름',
      changes: [{ path: '자료', blobHash: hash }],
    });
    assert.equal(ontoFolder.statusCode, 409);
    assert.deepEqual(ontoFolder.json().error.details.conflicts, ['자료']);
  });

  it('제안 이후 head 에 이름이 겹치는 파일이 생기면 병합할 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '안.txt', '새 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '새 폴더',
      changes: [{ path: '새폴더/안.txt', blobHash: hash }],
    });
    assert.equal(created.statusCode, 201);
    const proposalId = created.json().proposal.id;

    // 소유자가 같은 이름의 "파일" 을 먼저 만든다.
    await uploadFile(h.app, owner, repoId, '새폴더', '파일');

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(owner),
    });
    const proposal = detail.json().proposal as ProposalDetail;
    assert.equal(proposal.mergeable, false);
    assert.deepEqual(proposal.conflicts, ['새폴더/안.txt']);

    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 409);
    assert.deepEqual(merged.json().error.details.conflicts, ['새폴더/안.txt']);
  });

  it('병합 결과가 저장소 파일 수 한도를 넘으면 409 다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '새.txt', '새 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '하나 더',
      changes: [{ path: '새.txt', blobHash: hash }],
    });
    assert.equal(created.statusCode, 201);
    const proposalId = created.json().proposal.id;

    // 제안 뒤에 저장소가 한도까지 차는 상황을 스냅샷을 직접 써서 만든다 (업로드 수천 번은 너무 느리다).
    const { db } = h.ctx;
    const repo = getRepoRow(db, repoId)!;
    const manifest = readManifest(db, repo.head_snapshot_id);
    const filler = manifest.get('보고서.txt')!;
    db.transaction(() => {
      for (let i = manifest.size; i < MAX_FILES_PER_REPO; i += 1) {
        const path = `채움/${i}.txt`;
        manifest.set(path, { ...filler, path });
      }
      writeSnapshot(db, {
        repoId,
        parentId: repo.head_snapshot_id,
        authorId: owner.userId,
        message: '채움',
        manifest,
      });
    })();

    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 409);
    assert.match(merged.json().error.message, /최대/);
  });

  it('병합되거나 닫힌 제안의 제목은 고칠 수 없다', async () => {
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '고친 내용');
    const created = await createProposal(h, viewer, repoId, {
      title: '수정',
      changes: [{ path: '보고서.txt', blobHash: hash }],
    });
    const proposalId = created.json().proposal.id;
    const patch = (title: string) =>
      h.app.inject({
        method: 'PATCH',
        url: `/api/proposals/${proposalId}`,
        headers: auth(viewer),
        payload: { title },
      });
    const act = (action: string, session: Session) =>
      h.app.inject({ method: 'POST', url: `/api/proposals/${proposalId}/${action}`, headers: auth(session) });

    const open = await patch('열린 동안 수정');
    assert.equal(open.statusCode, 200);
    assert.equal(open.json().proposal.title, '열린 동안 수정');

    await act('close', viewer);
    const closed = await patch('닫힌 뒤 수정');
    assert.equal(closed.statusCode, 409);

    await act('reopen', viewer);
    assert.equal((await act('merge', owner)).statusCode, 200);
    const merged = await patch('병합 뒤 수정');
    assert.equal(merged.statusCode, 409);

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(owner),
    });
    assert.equal(detail.json().proposal.title, '열린 동안 수정');
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

describe('용량 한도', () => {
  let h: Harness;
  let owner: Session;
  let viewer: Session;
  let repoId: string;

  /** blob 업로드 응답을 그대로 돌려준다 (uploadBlob 은 실패하면 throw 한다). */
  function postBlob(session: Session, repo: string, name: string, content: Buffer) {
    const part = multipart(name, content);
    return h.app.inject({
      method: 'POST',
      url: `/api/repos/${repo}/blobs`,
      headers: { ...auth(session), ...part.headers },
      payload: part.body,
    });
  }

  beforeEach(async () => {
    // 저장소 총 100바이트, 사용자당 하루 150바이트.
    h = await createHarness({ maxRepoBytes: 100, maxStagingBytesPerDay: 150 });
    owner = await signup(h.app, '소유자');
    viewer = await signup(h.app, '기여자');
    repoId = await createRepo(h.app, owner, '작은 저장소');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);
  });
  afterEach(async () => {
    await h.close();
  });

  it('저장소 용량 한도를 넘는 업로드는 413 이다', async () => {
    assert.equal((await uploadFile(h.app, owner, repoId, 'a.bin', Buffer.alloc(60, 1))).statusCode, 201);
    const over = await uploadFile(h.app, owner, repoId, 'b.bin', Buffer.alloc(50, 2));
    assert.equal(over.statusCode, 413);
    assert.equal(over.json().error.code, 'payload_too_large');
    assert.match(over.json().error.message, /저장소 용량 한도/);

    // 교체되는 파일의 크기는 빼고 센다: 60 → 100 은 한도 안이다.
    assert.equal((await uploadFile(h.app, owner, repoId, 'a.bin', Buffer.alloc(100, 3))).statusCode, 201);
    assert.equal((await uploadFile(h.app, owner, repoId, 'b.bin', Buffer.alloc(1, 4))).statusCode, 413);

    const repo = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    assert.equal(repo.json().repo.totalSize, 100);
    assert.equal(repo.json().repo.fileCount, 1);
  });

  it('제안을 만들 때도 저장소 용량 한도를 본다', async () => {
    await uploadFile(h.app, owner, repoId, 'a.bin', Buffer.alloc(60, 1));
    const blob50 = await uploadBlob(h.app, viewer, repoId, 'b.bin', Buffer.alloc(50, 2));

    const add = await createProposal(h, viewer, repoId, {
      title: '추가',
      changes: [{ path: 'b.bin', blobHash: blob50 }],
    });
    assert.equal(add.statusCode, 413);
    assert.match(add.json().error.message, /저장소 용량 한도/);

    // 교체(60 → 50)나 삭제를 함께 담으면 한도 안이다.
    const replace = await createProposal(h, viewer, repoId, {
      title: '교체',
      changes: [{ path: 'a.bin', blobHash: blob50 }],
    });
    assert.equal(replace.statusCode, 201);
    const swap = await createProposal(h, viewer, repoId, {
      title: '바꾸기',
      changes: [
        { path: 'b.bin', blobHash: blob50 },
        { path: 'a.bin', blobHash: null },
      ],
    });
    assert.equal(swap.statusCode, 201);
  });

  it('병합 결과가 저장소 용량 한도를 넘으면 413 이다', async () => {
    await uploadFile(h.app, owner, repoId, 'a.bin', Buffer.alloc(30, 1));
    const blob50 = await uploadBlob(h.app, viewer, repoId, 'b.bin', Buffer.alloc(50, 2));
    const created = await createProposal(h, viewer, repoId, {
      title: '추가',
      changes: [{ path: 'b.bin', blobHash: blob50 }],
    });
    assert.equal(created.statusCode, 201);
    const proposalId = created.json().proposal.id;

    // 제안 뒤에 저장소가 커져서, 병합하면 한도를 넘게 된다.
    await uploadFile(h.app, owner, repoId, 'c.bin', Buffer.alloc(40, 3));
    const merged = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/merge`,
      headers: auth(owner),
    });
    assert.equal(merged.statusCode, 413);
    assert.match(merged.json().error.message, /저장소 용량 한도/);

    // 막혔으니 제안은 열린 채로 남고 head 도 그대로다.
    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${proposalId}`,
      headers: auth(owner),
    });
    assert.equal(detail.json().proposal.status, 'open');
    const repo = await h.app.inject({ method: 'GET', url: `/api/repos/${repoId}`, headers: auth(owner) });
    assert.equal(repo.json().repo.totalSize, 70);
  });

  it('하루 업로드 한도를 넘으면 blob 을 올릴 수 없다', async () => {
    assert.equal((await postBlob(viewer, repoId, '1.bin', Buffer.alloc(100, 1))).statusCode, 201);
    const over = await postBlob(viewer, repoId, '2.bin', Buffer.alloc(60, 2));
    assert.equal(over.statusCode, 413);
    assert.equal(over.json().error.code, 'payload_too_large');
    assert.match(over.json().error.message, /하루 업로드 한도/);
    // 거부된 blob 파일은 디스크에 남지 않는다 (지우지 않으면 한도와 무관하게 디스크가 찬다).
    const rejectedHash = createHash('sha256').update(Buffer.alloc(60, 2)).digest('hex');
    assert.equal(await h.ctx.blobs.has(rejectedHash), false);

    // 같은 내용을 같은 저장소에 다시 올리는 것은 새로 저장되지 않으므로 막지 않는다.
    assert.equal((await postBlob(viewer, repoId, '1.bin', Buffer.alloc(100, 1))).statusCode, 201);
    // 거부된 것은 한도 계산에 들어가지 않는다: 100 + 50 = 150 은 된다.
    assert.equal((await postBlob(viewer, repoId, '3.bin', Buffer.alloc(50, 3))).statusCode, 201);
    // 한도를 다 쓰면 스트림을 받기 전에 거절되고 디스크에도 아무것도 남지 않는다.
    assert.equal((await postBlob(viewer, repoId, '4.bin', Buffer.alloc(1, 4))).statusCode, 413);
    const earlyHash = createHash('sha256').update(Buffer.alloc(1, 4)).digest('hex');
    assert.equal(await h.ctx.blobs.has(earlyHash), false);
    // 다른 사용자의 한도는 따로 센다.
    assert.equal((await postBlob(owner, repoId, '5.bin', Buffer.alloc(100, 5))).statusCode, 201);

    // 24시간이 지나면 다시 올릴 수 있다.
    h.ctx.db
      .prepare(`UPDATE repo_blobs SET created_at = created_at - ? WHERE uploaded_by = ?`)
      .run(25 * 60 * 60 * 1000, viewer.userId);
    assert.equal((await postBlob(viewer, repoId, '4.bin', Buffer.alloc(1, 4))).statusCode, 201);
  });
});
