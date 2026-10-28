import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { MyProposal, ProposalDetail, RepoEvent } from '@listup/shared';
import { collectGarbage } from '../src/services/gc.ts';
import {
  auth,
  createHarness,
  createInvite,
  createRepo,
  join,
  signup,
  uploadBlob,
  type Harness,
  type Session,
} from './helpers.ts';

let h: Harness;
afterEach(async () => {
  await h.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function loginAgain(session: Session): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: session.email, password: 'password1234' },
  });
  return (res.json() as { token: string }).token;
}

const me = (token: string) => h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });

describe('로그아웃', () => {
  it('로그아웃한 토큰은 바로 401 이고, 다른 기기의 토큰은 그대로다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const other = await loginAgain(user);

    const res = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(user) });
    assert.equal(res.statusCode, 200);

    // 앱이 지우기 전에 복사해 둔 토큰이라도 더는 통하지 않는다.
    assert.equal((await me(user.token)).statusCode, 401);
    assert.equal((await me(other)).statusCode, 200);
    // 토큰 원문은 DB 에 남기지 않는다.
    const rows = h.ctx.db.prepare(`SELECT token_hash FROM revoked_tokens`).all() as { token_hash: string }[];
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, user.token);
  });

  it('만료 시각이 지난 기록은 GC 가 지운다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(user) });
    h.ctx.db.prepare(`UPDATE revoked_tokens SET expires_at = ?`).run(Date.now() - 1);

    await collectGarbage(h.ctx, 60_000);
    const left = h.ctx.db.prepare(`SELECT COUNT(*) AS c FROM revoked_tokens`).get() as { c: number };
    assert.equal(left.c, 0);
  });

  it('다른 기기 모두 로그아웃 — 다른 토큰은 401, 이 기기는 새 토큰으로 이어 간다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const other = await loginAgain(user);

    const res = await h.app.inject({ method: 'POST', url: '/api/auth/logout-others', headers: auth(user) });
    assert.equal(res.statusCode, 200);
    const next = (res.json() as { token: string }).token;

    assert.equal((await me(other)).statusCode, 401);
    assert.equal((await me(user.token)).statusCode, 401);
    assert.equal((await me(next)).statusCode, 200);
    // 비밀번호는 그대로라 다시 로그인할 수 있다.
    assert.equal((await me(await loginAgain(user))).statusCode, 200);
  });
});

describe('내 제안', () => {
  async function setup() {
    h = await createHarness();
    const owner = await signup(h.app, '주인');
    const viewer = await signup(h.app, '기여자');
    const repoId = await createRepo(h.app, owner, '보고서 모음');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);
    const hash = await uploadBlob(h.app, viewer, repoId, '보고서.txt', '새 내용');
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/proposals`,
      headers: auth(viewer),
      payload: { title: '보고서 추가', changes: [{ path: '보고서.txt', blobHash: hash }] },
    });
    assert.equal(created.statusCode, 201);
    const proposal = created.json().proposal as ProposalDetail;
    return { owner, viewer, repoId, proposal };
  }

  async function mine(session: Session): Promise<MyProposal[]> {
    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/mine', headers: auth(session) });
    assert.equal(res.statusCode, 200);
    return (res.json() as { proposals: MyProposal[] }).proposals;
  }

  const comment = (session: Session, id: string, text: string) =>
    h.app.inject({ method: 'POST', url: `/api/proposals/${id}/comments`, headers: auth(session), payload: { body: text } });
  const open = (session: Session, id: string) =>
    h.app.inject({ method: 'GET', url: `/api/proposals/${id}`, headers: auth(session) });

  it('저장소를 가로질러 내가 올린 제안만, 저장소 이름과 함께', async () => {
    const { owner, viewer, proposal } = await setup();
    const list = await mine(viewer);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, proposal.id);
    assert.equal(list[0].repoName, '보고서 모음');
    assert.equal(list[0].unseen, false);
    assert.equal(list[0].decidedAt, null);
    assert.deepEqual(await mine(owner), []);
  });

  it('반영되면 새 소식이 되고, 상세를 열면 풀린다', async () => {
    const { owner, viewer, proposal } = await setup();
    const merged = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/merge`, headers: auth(owner) });
    assert.equal(merged.statusCode, 200);

    let [item] = await mine(viewer);
    assert.equal(item.status, 'merged');
    assert.equal(item.unseen, true);
    assert.equal(item.decidedBy?.displayName, '주인');
    assert.ok(item.decidedAt);

    // 다른 사람이 열어 봐도 작성자의 새 소식은 그대로다.
    await open(owner, proposal.id);
    assert.equal((await mine(viewer))[0].unseen, true);

    await open(viewer, proposal.id);
    [item] = await mine(viewer);
    assert.equal(item.unseen, false);
  });

  it('남의 의견은 새 소식이고, 내 의견은 아니다', async () => {
    const { owner, viewer, proposal } = await setup();
    await comment(viewer, proposal.id, '확인 부탁드립니다.');
    assert.equal((await mine(viewer))[0].unseen, false);

    await comment(owner, proposal.id, '한 줄만 고쳐 주세요.');
    assert.equal((await mine(viewer))[0].unseen, true);
  });

  it('닫을 때 적은 이유는 의견으로 남고, 다시 열면 결정이 지워진다', async () => {
    const { owner, viewer, proposal } = await setup();
    const closed = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/close`,
      headers: auth(owner),
      payload: { reason: '이미 다른 제안으로 반영했습니다.' },
    });
    assert.equal(closed.statusCode, 200);
    const detail = closed.json().proposal as ProposalDetail;
    assert.equal(detail.status, 'closed');
    assert.equal(detail.decidedBy?.displayName, '주인');
    assert.equal(detail.comments.at(-1)?.body, '이미 다른 제안으로 반영했습니다.');
    assert.equal(detail.comments.at(-1)?.author.displayName, '주인');

    const reopened = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/reopen`, headers: auth(viewer) });
    const again = reopened.json().proposal as ProposalDetail;
    assert.equal(again.status, 'open');
    assert.equal(again.decidedAt, null);
    assert.equal(again.decidedBy, null);
  });

  it('이유 없이 닫아도 되고, 너무 긴 이유는 400', async () => {
    const { owner, proposal } = await setup();
    const tooLong = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/close`,
      headers: auth(owner),
      payload: { reason: 'x'.repeat(2001) },
    });
    assert.equal(tooLong.statusCode, 400);

    const plain = await h.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/close`, headers: auth(owner) });
    assert.equal(plain.statusCode, 200);
    assert.equal((plain.json().proposal as ProposalDetail).comments.length, 0);
  });

  it('나간 저장소의 제안은 목록에서 빠진다', async () => {
    const { viewer } = await setup();
    const repoId = (await mine(viewer))[0].repoId;
    const left = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/members/${viewer.userId}`,
      headers: auth(viewer),
    });
    assert.equal(left.statusCode, 200);
    assert.deepEqual(await mine(viewer), []);
  });
});

describe('저장소 활동 기록', () => {
  async function events(session: Session, repoId: string, query = '') {
    return h.app.inject({ method: 'GET', url: `/api/repos/${repoId}/events${query}`, headers: auth(session) });
  }
  const kinds = (list: RepoEvent[]) => list.map((e) => e.kind);

  it('멤버·초대 변화를 최근 것부터 남긴다', async () => {
    h = await createHarness();
    const owner = await signup(h.app, '주인');
    const a = await signup(h.app, '가');
    const b = await signup(h.app, '나');
    const repoId = await createRepo(h.app, owner, '저장소');

    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, a, invite.code);
    await join(h.app, b, invite.code);
    // 같은 링크를 두 번 눌러도 참여는 한 번만 남는다.
    await join(h.app, a, invite.code);
    await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}/members/${a.userId}`,
      headers: auth(owner),
      payload: { role: 'editor' },
    });
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/members/${b.userId}`, headers: auth(owner) });
    await h.app.inject({ method: 'DELETE', url: `/api/invites/${invite.id}`, headers: auth(owner) });
    await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/transfer`,
      headers: auth(owner),
      payload: { userId: a.userId },
    });
    // 이제 a 가 소유자. 예전 소유자가 나간다.
    await h.app.inject({ method: 'DELETE', url: `/api/repos/${repoId}/members/${owner.userId}`, headers: auth(owner) });

    const res = await events(a, repoId);
    assert.equal(res.statusCode, 200);
    const list = (res.json() as { events: RepoEvent[] }).events;
    assert.deepEqual(kinds(list), [
      'member_left',
      'owner_transferred',
      'invite_revoked',
      'member_removed',
      'role_changed',
      'member_joined',
      'member_joined',
      'invite_created',
      'repo_created',
    ]);
    const [left, transferred, , removed, changed, joinedB] = list;
    assert.equal(left.actor?.displayName, '주인');
    assert.equal(transferred.target?.displayName, '가');
    assert.equal(removed.actor?.displayName, '주인');
    assert.equal(removed.target?.displayName, '나');
    assert.equal(changed.target?.displayName, '가');
    assert.equal(changed.role, 'editor');
    assert.equal(joinedB.actor?.displayName, '나');
    assert.equal(joinedB.role, 'viewer');
  });

  it('소유자만 본다 — 편집자는 403, 멤버가 아니면 404', async () => {
    h = await createHarness();
    const owner = await signup(h.app, '주인');
    const editor = await signup(h.app, '편집자');
    const stranger = await signup(h.app, '남');
    const repoId = await createRepo(h.app, owner, '저장소');
    const invite = await createInvite(h.app, owner, repoId, { role: 'editor' });
    await join(h.app, editor, invite.code);

    assert.equal((await events(editor, repoId)).statusCode, 403);
    assert.equal((await events(stranger, repoId)).statusCode, 404);
  });

  it('나눠 받는다', async () => {
    h = await createHarness();
    const owner = await signup(h.app, '주인');
    const repoId = await createRepo(h.app, owner, '저장소');
    for (let i = 0; i < 4; i += 1) await createInvite(h.app, owner, repoId);

    const first = (await events(owner, repoId, '?limit=3')).json() as { events: RepoEvent[]; next: { before: number } | null };
    assert.equal(first.events.length, 3);
    assert.ok(first.next);
    const second = (await events(owner, repoId, `?limit=3&before=${first.next.before}`)).json() as {
      events: RepoEvent[];
      next: unknown;
    };
    assert.deepEqual(kinds(second.events), ['invite_created', 'repo_created']);
    assert.equal(second.next, null);
  });
});
