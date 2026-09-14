import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { issueResetCode } from '../src/services/password-reset.ts';
import { auth, createHarness, signup, type Harness, type Session } from './helpers.ts';

describe('비밀번호 재설정 코드', () => {
  let h: Harness;
  let user: Session;

  before(async () => {
    h = await createHarness({ loginFailureLimit: 5 });
    user = await signup(h.app, '잊은사람');
  });
  after(async () => {
    await h.close();
  });

  const reset = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/auth/reset', payload });
  const login = (password: string) =>
    h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password } });

  it('발급한 코드로 새 비밀번호를 정하면 바로 로그인되고, 다른 기기 로그인은 끊긴다', async () => {
    const issued = issueResetCode(h.ctx.db, user.email)!;
    assert.match(issued.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    const res = await reset({ email: user.email, code: issued.code.toLowerCase(), newPassword: 'brand-new-pass' });
    assert.equal(res.statusCode, 200, res.body);
    const { token } = res.json();
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    // 예전 토큰은 끊긴다
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(user) })).statusCode, 401);
    assert.equal((await login('brand-new-pass')).statusCode, 200);
    assert.equal((await login('password1234')).statusCode, 401);
    user = { ...user, token };
  });

  it('코드는 한 번만, 새로 발급하면 이전 코드는 못 쓴다', async () => {
    const first = issueResetCode(h.ctx.db, user.email)!;
    assert.equal((await reset({ email: user.email, code: first.code, newPassword: 'once-more-1' })).statusCode, 200);
    assert.equal((await reset({ email: user.email, code: first.code, newPassword: 'twice-more-1' })).statusCode, 400);

    const older = issueResetCode(h.ctx.db, user.email)!;
    const newer = issueResetCode(h.ctx.db, user.email)!;
    assert.equal((await reset({ email: user.email, code: older.code, newPassword: 'older-code-1' })).statusCode, 400);
    assert.equal((await reset({ email: user.email, code: newer.code, newPassword: 'newer-code-1' })).statusCode, 200);
  });

  it('만료된 코드·다른 사람 이메일·없는 계정은 400, 짧은 비밀번호도 400', async () => {
    const other = await signup(h.app, '다른사람');
    const expired = issueResetCode(h.ctx.db, user.email, Date.now() - 60 * 60 * 1000)!;
    assert.equal((await reset({ email: user.email, code: expired.code, newPassword: 'expired-1234' })).statusCode, 400);
    const mine = issueResetCode(h.ctx.db, user.email)!;
    assert.equal((await reset({ email: other.email, code: mine.code, newPassword: 'not-yours-1' })).statusCode, 400);
    assert.equal((await reset({ email: 'nobody@x.test', code: mine.code, newPassword: 'nobody-1234' })).statusCode, 400);
    assert.equal((await reset({ email: user.email, code: mine.code, newPassword: 'short' })).statusCode, 400);
    assert.equal(issueResetCode(h.ctx.db, 'nobody@x.test'), null);
  });

  it('틀린 코드를 계속 넣으면 로그인과 같은 제한으로 막힌다', async () => {
    const victim = await signup(h.app, '노림받는사람');
    let last = 0;
    for (let i = 0; i < 7; i += 1) {
      last = (await reset({ email: victim.email, code: 'AAAAA-AAAAA', newPassword: 'guess-1234' })).statusCode;
    }
    assert.equal(last, 429);
  });
});
