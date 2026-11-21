import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { auth, createHarness, signup, type Harness } from './helpers.ts';

/**
 * 대입 제한이 **동시 요청**에도 지켜지는지 (2026-11-21 검토).
 * 비밀번호 확인(scrypt)이 비동기라, 확인 → (기다림) → 실패 기록 순이면 한꺼번에 보낸 요청이 모두 확인을 통과한 뒤에야
 * 실패가 쌓인다 — 한도 3 이어도 한 번에 수백 개를 맞혀 볼 수 있었다.
 */
describe('대입 제한 — 동시 요청', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ loginFailureLimit: 3 });
  });
  afterEach(async () => {
    await h.close();
  });

  it('틀린 로그인을 한꺼번에 30개 보내도 한도(3)를 넘는 것은 확인 전에 429', async () => {
    const user = await signup(h.app, '동시');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        h.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: user.email, password: `guess-${i}-xxxx` },
        }),
      ),
    );
    const checked = results.filter((res) => res.statusCode === 401).length;
    assert.ok(checked <= 3, `비밀번호를 실제로 확인한 요청 ${checked}개 — 한도 3 을 넘었다`);
    assert.equal(results.filter((res) => res.statusCode === 429).length, 30 - checked);
  });

  it('틀린 재설정 코드를 한꺼번에 보내도 한도를 넘지 않는다', async () => {
    const user = await signup(h.app, '동시재설정');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        h.app.inject({
          method: 'POST',
          url: '/api/auth/reset',
          payload: { email: user.email, code: `AAAAA-${String(10000 + i).slice(-5).replace(/[01]/g, '2')}`, newPassword: 'new-password-1' },
        }),
      ),
    );
    const checked = results.filter((res) => res.statusCode === 400).length;
    assert.ok(checked <= 3, `코드를 실제로 확인한 요청 ${checked}개 — 한도 3 을 넘었다`);
  });

  it('맞는 비밀번호는 실패 기록이 있어도(한도 전) 들어가고 기록을 지운다', async () => {
    const user = await signup(h.app, '정상');
    const login = (password: string) =>
      h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password } });
    assert.equal((await login('wrong-one-xx')).statusCode, 401);
    assert.equal((await login('wrong-two-xx')).statusCode, 401);
    assert.equal((await login('password1234')).statusCode, 200);
    // 지워졌으니 다시 두 번 틀려도 막히지 않는다.
    assert.equal((await login('wrong-three')).statusCode, 401);
    assert.equal((await login('wrong-four-')).statusCode, 401);
    assert.equal((await login('password1234')).statusCode, 200);
  });
});

describe('비밀번호 바꾸기 — 훔친 토큰으로 현재 비밀번호 맞혀 보기', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ loginFailureLimit: 3 });
  });
  after(async () => {
    await h.close();
  });

  it('/auth/password 의 현재 비밀번호도 로그인과 같은 제한으로 센다', async () => {
    // 복구 코드 만들기(POST /auth/recovery-codes)는 막는데 여기가 열려 있으면 그 막음이 소용없다.
    const user = await signup(h.app, '토큰도둑2');
    const change = (currentPassword: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: auth(user),
        payload: { currentPassword, newPassword: 'taken-over-1' },
      });
    let last = 0;
    for (let i = 0; i < 5; i += 1) last = (await change(`guess-${i}-xxxx`)).statusCode;
    assert.equal(last, 429);
    assert.equal((await change('password1234')).statusCode, 429, '막힌 동안은 맞는 비밀번호도');
  });
});

describe('복구 코드 — 같은 코드를 동시에', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ loginFailureLimit: 1000 });
  });
  after(async () => {
    await h.close();
  });

  it('같은 복구 코드로 동시에 두 번 재설정하면 하나만 성공한다', async () => {
    const user = await signup(h.app, '동시코드');
    const issued = await h.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-codes',
      headers: auth(user),
      payload: { currentPassword: 'password1234' },
    });
    const code = (issued.json() as { codes: string[] }).codes[0];
    const results = await Promise.all(
      ['first-password-1', 'second-password-2'].map((newPassword) =>
        h.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { code, newPassword } }),
      ),
    );
    assert.deepEqual(results.map((res) => res.statusCode).sort(), [200, 400]);
  });
});
