import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { formatInviteCode } from '@listup/shared';
import {
  auth,
  createHarness,
  createInvite,
  createRepo,
  join,
  signup,
  type Harness,
  type Session,
} from './helpers.ts';

describe('초대 코드', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '공유 폴더');
  });
  after(async () => {
    await h.close();
  });

  it('코드로 참여하면 지정된 역할로 들어간다', async () => {
    const guest = await signup(h.app, '손님');
    const invite = await createInvite(h.app, owner, repoId, { role: 'editor' });

    const preview = await h.app.inject({
      method: 'GET',
      url: `/api/invites/${invite.code}`,
      headers: auth(guest),
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().invite.repo.name, '공유 폴더');
    assert.equal(preview.json().invite.currentRole, null);

    const joined = await join(h.app, guest, invite.code);
    assert.equal(joined.statusCode, 200);
    assert.equal(JSON.parse(joined.body).repo.role, 'editor');
  });

  it('하이픈이 들어간 형태로 입력해도 참여된다', async () => {
    const guest = await signup(h.app, '손님2');
    const invite = await createInvite(h.app, owner, repoId);
    const pretty = formatInviteCode(invite.code);
    assert.ok(pretty.includes('-'));

    const joined = await join(h.app, guest, encodeURIComponent(pretty));
    assert.equal(joined.statusCode, 200);
    assert.equal(JSON.parse(joined.body).repo.role, 'viewer');
  });

  it('사용 횟수를 다 쓰면 더는 못 들어온다', async () => {
    const invite = await createInvite(h.app, owner, repoId, { maxUses: 1 });
    const first = await signup(h.app, '선착순1');
    const second = await signup(h.app, '선착순2');

    assert.equal((await join(h.app, first, invite.code)).statusCode, 200);
    const late = await join(h.app, second, invite.code);
    assert.equal(late.statusCode, 409);
  });

  it('이미 멤버면 사용 횟수를 소모하지 않는다', async () => {
    const invite = await createInvite(h.app, owner, repoId, { maxUses: 2 });
    const guest = await signup(h.app, '두번참여');

    assert.equal((await join(h.app, guest, invite.code)).statusCode, 200);
    const again = await join(h.app, guest, invite.code);
    assert.equal(again.statusCode, 200);
    assert.equal(JSON.parse(again.body).alreadyMember, true);

    // 두 번째 호출이 자리를 잡아먹지 않았으므로 두 명이 더 들어올 수 있어야 한다.
    const second = await signup(h.app, '남은자리');
    assert.equal((await join(h.app, second, invite.code)).statusCode, 200);
    const third = await signup(h.app, '자리없음');
    assert.equal((await join(h.app, third, invite.code)).statusCode, 409);
  });

  it('코드를 다 쓴 뒤에도 이미 참여한 사람은 미리보기를 볼 수 있다', async () => {
    const invite = await createInvite(h.app, owner, repoId, { maxUses: 1 });
    const guest = await signup(h.app, '소진후조회');
    assert.equal((await join(h.app, guest, invite.code)).statusCode, 200);

    const preview = await h.app.inject({
      method: 'GET',
      url: `/api/invites/${invite.code}`,
      headers: auth(guest),
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().invite.currentRole, 'viewer');

    // 반면 처음 오는 사람에게는 소진된 코드라고 알려준다.
    const stranger = await signup(h.app, '소진후신규');
    const denied = await h.app.inject({
      method: 'GET',
      url: `/api/invites/${invite.code}`,
      headers: auth(stranger),
    });
    assert.equal(denied.statusCode, 409);
  });

  it('회수한 코드는 쓸 수 없다', async () => {
    const invite = await createInvite(h.app, owner, repoId);
    const revoke = await h.app.inject({
      method: 'DELETE',
      url: `/api/invites/${invite.id}`,
      headers: auth(owner),
    });
    assert.equal(revoke.statusCode, 200);

    const guest = await signup(h.app, '늦은손님');
    assert.equal((await join(h.app, guest, invite.code)).statusCode, 409);
  });

  it('만료된 코드는 쓸 수 없다', async () => {
    const invite = await createInvite(h.app, owner, repoId);
    // 만료 시각을 과거로 돌린다.
    h.ctx.db.prepare(`UPDATE invites SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, invite.id);

    const guest = await signup(h.app, '만료손님');
    const res = await join(h.app, guest, invite.code);
    assert.equal(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error.message, /만료/);
  });

  it('없는 코드와 형식이 틀린 코드를 구분해서 알려준다', async () => {
    const guest = await signup(h.app, '오타손님');
    const badFormat = await join(h.app, guest, 'ABC');
    assert.equal(badFormat.statusCode, 400);

    const notFound = await join(h.app, guest, '22222222222'.slice(0, 10));
    assert.equal(notFound.statusCode, 404);
  });

  it('열람 권한만 있는 사람은 초대를 만들 수 없다', async () => {
    const viewer = await signup(h.app, '초대불가');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, viewer, invite.code);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/invites`,
      headers: auth(viewer),
      payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  it('초대로 소유자 권한을 줄 수는 없다', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/invites`,
      headers: auth(owner),
      payload: { role: 'owner' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('멤버 관리', () => {
  let h: Harness;
  let owner: Session;
  let member: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '주인');
    member = await signup(h.app, '동료');
    repoId = await createRepo(h.app, owner, '팀 자료');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, member, invite.code);
  });
  after(async () => {
    await h.close();
  });

  it('소유자만 역할을 바꿀 수 있다', async () => {
    const byMember = await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}/members/${member.userId}`,
      headers: auth(member),
      payload: { role: 'editor' },
    });
    assert.equal(byMember.statusCode, 403);

    const byOwner = await h.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repoId}/members/${member.userId}`,
      headers: auth(owner),
      payload: { role: 'editor' },
    });
    assert.equal(byOwner.statusCode, 200);
    const roles = Object.fromEntries(
      byOwner.json().members.map((m: { userId: string; role: string }) => [m.userId, m.role]),
    );
    assert.equal(roles[member.userId], 'editor');
  });

  it('이메일은 소유자에게만 보인다', async () => {
    const asOwner = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/members`,
      headers: auth(owner),
    });
    const asMember = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}/members`,
      headers: auth(member),
    });
    assert.ok(asOwner.json().members.every((m: { email: string | null }) => m.email !== null));
    assert.ok(asMember.json().members.every((m: { email: string | null }) => m.email === null));
  });

  it('소유자는 저장소를 나갈 수 없다', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/members/${owner.userId}`,
      headers: auth(owner),
    });
    assert.equal(res.statusCode, 409);
  });

  it('스스로 나가면 접근이 끊긴다', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/repos/${repoId}/members/${member.userId}`,
      headers: auth(member),
    });
    assert.equal(res.statusCode, 200);

    const after = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}`,
      headers: auth(member),
    });
    assert.equal(after.statusCode, 404);
  });

  it('소유권을 넘기면 넘긴 사람은 편집자로 남는다', async () => {
    const successor = await signup(h.app, '후임');
    const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
    await join(h.app, successor, invite.code);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/transfer`,
      headers: auth(owner),
      payload: { userId: successor.userId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().repo.role, 'editor');
    assert.equal(res.json().repo.ownerId, successor.userId);
  });
});
