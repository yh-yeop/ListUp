import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { auth, createHarness, createRepo, signup, type Harness } from './helpers.ts';

let h: Harness;
afterEach(async () => {
  await h.close();
});

describe('로그인 요청 제한', () => {
  const login = (email: string, password: string, ip = '203.0.113.10') =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
      // fastify 는 inject 의 remoteAddress 를 req.ip 로 쓴다.
      remoteAddress: ip,
    });

  it('여러 번 틀리면 막고, 얼마 뒤에 다시 되는지 알려준다', async () => {
    h = await createHarness({ loginFailureLimit: 3 });
    const user = await signup(h.app, '사용자');

    for (let i = 0; i < 3; i += 1) {
      const res = await login(user.email, 'wrong-password');
      assert.equal(res.statusCode, 401, `${i + 1}번째 시도는 아직 401 이어야 한다`);
    }

    const blocked = await login(user.email, 'wrong-password');
    assert.equal(blocked.statusCode, 429);
    const body = blocked.json() as { error: { code: string; details?: { retryAfterSeconds?: number } } };
    assert.equal(body.error.code, 'too_many_requests');
    assert.ok((body.error.details?.retryAfterSeconds ?? 0) > 0);

    // 막힌 동안에는 올바른 비밀번호도 통하지 않는다 — 그래야 대입을 늦출 수 있다.
    const correct = await login(user.email, 'password1234');
    assert.equal(correct.statusCode, 429);
  });

  it('성공하면 실패 기록이 지워진다', async () => {
    h = await createHarness({ loginFailureLimit: 3 });
    const user = await signup(h.app, '사용자');

    assert.equal((await login(user.email, 'wrong-password')).statusCode, 401);
    assert.equal((await login(user.email, 'wrong-password')).statusCode, 401);
    assert.equal((await login(user.email, 'password1234')).statusCode, 200);

    // 기록이 지워졌으므로 다시 한도만큼 시도할 수 있다.
    assert.equal((await login(user.email, 'wrong-password')).statusCode, 401);
    assert.equal((await login(user.email, 'wrong-password')).statusCode, 401);
    assert.equal((await login(user.email, 'wrong-password')).statusCode, 401);
    assert.equal((await login(user.email, 'wrong-password')).statusCode, 429);
  });

  it('한 계정을 막아도 다른 계정은 다른 IP 에서 로그인할 수 있다', async () => {
    h = await createHarness({ loginFailureLimit: 2 });
    const victim = await signup(h.app, '피해자');
    const other = await signup(h.app, '다른사람');

    await login(victim.email, 'wrong-password', '203.0.113.10');
    await login(victim.email, 'wrong-password', '203.0.113.10');
    assert.equal((await login(victim.email, 'password1234', '203.0.113.10')).statusCode, 429);

    const ok = await login(other.email, 'password1234', '198.51.100.20');
    assert.equal(ok.statusCode, 200);
  });

  it('같은 IP 에서 계정을 바꿔 가며 시도해도 IP 기준으로 막힌다', async () => {
    h = await createHarness({ loginFailureLimit: 3 });
    const target = await signup(h.app, '표적');

    for (let i = 0; i < 3; i += 1) {
      await login(`nobody${i}@example.com`, 'guessing', '203.0.113.99');
    }
    const res = await login(target.email, 'password1234', '203.0.113.99');
    assert.equal(res.statusCode, 429);
  });
});

describe('비밀번호를 바꾸면 이전 토큰이 끊긴다', () => {
  it('다른 기기의 토큰은 401, 바꾼 기기는 새 토큰으로 이어 간다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');
    const repoId = await createRepo(h.app, user, '내 저장소');

    // 다른 기기에서 로그인해 둔 토큰.
    const otherDevice = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'password1234' },
    });
    const otherToken = (otherDevice.json() as { token: string }).token;
    const useOther = () =>
      h.app.inject({
        method: 'GET',
        url: `/api/repos/${repoId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
    assert.equal((await useOther()).statusCode, 200);

    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: auth(user),
      payload: { currentPassword: 'password1234', newPassword: 'brand-new-password' },
    });
    assert.equal(changed.statusCode, 200);
    const nextToken = (changed.json() as { token: string }).token;
    assert.ok(nextToken && nextToken !== user.token);

    // 다른 기기 토큰은 서명이 맞아도 더 이상 통하지 않는다.
    assert.equal((await useOther()).statusCode, 401);
    // 비밀번호를 바꾼 기기의 옛 토큰도 마찬가지다.
    const oldSelf = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}`,
      headers: auth(user),
    });
    assert.equal(oldSelf.statusCode, 401);

    // 응답으로 받은 새 토큰은 바로 쓸 수 있다.
    const withNew = await h.app.inject({
      method: 'GET',
      url: `/api/repos/${repoId}`,
      headers: { authorization: `Bearer ${nextToken}` },
    });
    assert.equal(withNew.statusCode, 200);
  });

  it('현재 비밀번호가 틀리면 400 이고 세대는 그대로다', async () => {
    h = await createHarness();
    const user = await signup(h.app, '사용자');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: auth(user),
      payload: { currentPassword: 'not-the-password', newPassword: 'brand-new-password' },
    });
    // 401 이면 앱이 세션 만료로 보고 로그아웃해 버린다 — 입력 오류는 400.
    assert.equal(res.statusCode, 400);

    const still = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(user) });
    assert.equal(still.statusCode, 200);
  });
});
