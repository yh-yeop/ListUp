import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword, issueToken, verifyPassword, verifyToken } from '../src/lib/auth.ts';
import { normalizePath, parseInviteCode } from '@listup/shared';
import { createHarness, auth, signup, type Harness } from './helpers.ts';

describe('비밀번호 해시', () => {
  it('올바른 비밀번호만 통과시킨다', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', stored), true);
    assert.equal(await verifyPassword('correct horse batteru', stored), false);
    assert.equal(await verifyPassword('', stored), false);
  });

  it('같은 비밀번호라도 해시가 매번 다르다 (솔트)', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  it('형식이 깨진 해시는 거부한다', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', 'scrypt$1$2$3$4'), false);
  });
});

describe('토큰', () => {
  const secret = 'secret';

  it('발급한 토큰을 되돌려 읽는다', () => {
    const token = issueToken('usr_1', secret, 60_000);
    assert.deepEqual(verifyToken(token, secret), { userId: 'usr_1', epoch: 0 });
  });

  it('토큰에 실린 세대를 그대로 돌려준다', () => {
    const token = issueToken('usr_1', secret, 60_000, 3);
    assert.deepEqual(verifyToken(token, secret), { userId: 'usr_1', epoch: 3 });
  });

  it('서명이 다르면 거부한다', () => {
    const token = issueToken('usr_1', secret, 60_000);
    assert.equal(verifyToken(token, 'other-secret'), null);
  });

  it('페이로드를 바꿔치기하면 거부한다', () => {
    const token = issueToken('usr_1', secret, 60_000);
    const forged = Buffer.from(JSON.stringify({ sub: 'usr_2', exp: Date.now() + 60_000 })).toString(
      'base64url',
    );
    assert.equal(verifyToken(`${forged}.${token.split('.')[1]}`, secret), null);
  });

  it('만료된 토큰을 거부한다', () => {
    const token = issueToken('usr_1', secret, 1);
    assert.equal(verifyToken(token, secret, Date.now() + 1000), null);
  });
});

describe('경로 정규화', () => {
  it('앞뒤 슬래시와 중복을 정리한다', () => {
    assert.equal(normalizePath('/a//b/c.txt'), 'a/b/c.txt');
    assert.equal(normalizePath('a\\b.txt'), 'a/b.txt');
  });

  it('상위 경로 탈출을 막는다', () => {
    assert.equal(normalizePath('../etc/passwd'), null);
    assert.equal(normalizePath('a/../../b'), null);
    assert.equal(normalizePath('./a'), null);
    assert.equal(normalizePath(''), null);
    assert.equal(normalizePath('/'), null);
  });

  it('제어문자를 막는다', () => {
    assert.equal(normalizePath('a/\u0000b'), null);
    assert.equal(normalizePath('a/b\nc'), null);
  });
});

describe('초대 코드 파싱', () => {
  it('하이픈과 소문자를 받아준다', () => {
    assert.equal(parseInviteCode('23456-789AB'), '23456789AB');
    assert.equal(parseInviteCode('23456789ab'), '23456789AB');
    assert.equal(parseInviteCode(' 23456 789ab '), '23456789AB');
  });

  it('길이가 다르거나 혼동 문자가 있으면 거부한다', () => {
    assert.equal(parseInviteCode('2345'), null);
    assert.equal(parseInviteCode('23456789ABC'), null);
    assert.equal(parseInviteCode('OOOOOOOOOO'), null); // O, 0, 1, I, L 은 알파벳에서 뺐다
    assert.equal(parseInviteCode('1111111111'), null);
  });
});

describe('회원가입 / 로그인 API', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  it('가입하면 토큰과 사용자 정보를 준다', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'New.User@Example.com ', password: 'password1234', displayName: '새 사용자' },
    });
    assert.equal(res.statusCode, 201);
    const parsed = res.json() as { token: string; user: { email: string; displayName: string } };
    assert.ok(parsed.token);
    assert.equal(parsed.user.email, 'new.user@example.com');
    assert.equal(parsed.user.displayName, '새 사용자');
  });

  it('같은 이메일로 두 번 가입할 수 없다', async () => {
    const payload = { email: 'dup@example.com', password: 'password1234', displayName: '중복' };
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/signup', payload })).statusCode, 201);
    const second = await h.app.inject({ method: 'POST', url: '/api/auth/signup', payload });
    assert.equal(second.statusCode, 409);
  });

  it('짧은 비밀번호를 거부한다', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'short@example.com', password: 'short', displayName: '짧음' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('로그인 실패 시 이메일 존재 여부를 알려주지 않는다', async () => {
    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dup@example.com', password: 'wrongpassword' },
    });
    const noSuchUser = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrongpassword' },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(noSuchUser.statusCode, 401);
    assert.equal(wrongPassword.json().error.message, noSuchUser.json().error.message);
  });

  it('토큰 없이 보호된 API 를 부르면 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/repos' });
    assert.equal(res.statusCode, 401);
  });

  it('이름을 바꿀 수 있다', async () => {
    const session = await signup(h.app, '이전 이름');
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: auth(session),
      payload: { displayName: '새 이름' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.displayName, '새 이름');
  });

  it('현재 비밀번호를 틀리면 변경할 수 없다 (401 이 아니라 400)', async () => {
    const session = await signup(h.app, '비번 변경');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: auth(session),
      payload: { currentPassword: 'nope-not-it', newPassword: 'brandnewpassword' },
    });
    // 401 은 앱이 세션 만료로 해석해 로그아웃시키므로 입력 오류는 400 이어야 한다.
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'bad_request');

    // 세션은 그대로 살아 있다.
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(session) });
    assert.equal(me.statusCode, 200);
  });

  it('현재 비밀번호가 맞으면 바뀌고 새 비밀번호로 로그인된다', async () => {
    const session = await signup(h.app, '비번 변경 성공');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: auth(session),
      payload: { currentPassword: 'password1234', newPassword: 'brandnewpassword' },
    });
    assert.equal(res.statusCode, 200);

    const oldLogin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: session.email, password: 'password1234' },
    });
    assert.equal(oldLogin.statusCode, 401);
    const newLogin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: session.email, password: 'brandnewpassword' },
    });
    assert.equal(newLogin.statusCode, 200);
  });
});
