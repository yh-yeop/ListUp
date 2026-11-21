import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { RECOVERY_CODE_COUNT } from '@listup/shared';
import { issueResetCode } from '../src/services/password-reset.ts';
import { auth, createHarness, signup, type Harness, type Session } from './helpers.ts';

const PASSWORD = 'password1234';

async function issue(h: Harness, session: Session, currentPassword = PASSWORD) {
  return h.app.inject({
    method: 'POST',
    url: '/api/auth/recovery-codes',
    headers: auth(session),
    payload: { currentPassword },
  });
}

describe('복구 코드 — 운영자 없이 스스로 재설정', () => {
  let h: Harness;

  before(async () => {
    // 기능 시험은 실패가 여러 번 쌓여도 막히지 않게 넉넉히. 제한은 아래 describe 에서 따로 본다.
    h = await createHarness({ loginFailureLimit: 1000 });
  });
  after(async () => {
    await h.close();
  });

  const reset = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/auth/reset', payload });
  const status = (session: Session) =>
    h.app.inject({ method: 'GET', url: '/api/auth/recovery-codes', headers: auth(session) });
  const me = (token: string) =>
    h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });

  it('처음에는 없고, 비밀번호를 확인해 10개를 만든다 — 원문은 한 번만, DB 에는 해시만', async () => {
    const user = await signup(h.app, '복구');
    assert.deepEqual((await status(user)).json(), { remaining: 0, total: 0, createdAt: null });

    const res = await issue(h, user);
    assert.equal(res.statusCode, 201, res.body);
    const { codes, createdAt } = res.json() as { codes: string[]; createdAt: number };
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    for (const code of codes) assert.match(code, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual((await status(user)).json(), { remaining: 10, total: 10, createdAt });

    const stored = h.ctx.db
      .prepare<[string], { code_hash: string }>(`SELECT code_hash FROM recovery_codes WHERE user_id = ?`)
      .all(user.userId);
    assert.equal(stored.length, 10);
    for (const row of stored) {
      assert.match(row.code_hash, /^[0-9a-f]{64}$/);
      assert.ok(!codes.some((code) => row.code_hash.includes(code.replace(/-/g, ''))));
    }
  });

  it('비밀번호가 틀리면 400(401 아님 — 앱이 로그아웃하지 않게), 로그인 없이는 401', async () => {
    const user = await signup(h.app, '틀림');
    assert.equal((await issue(h, user, 'wrong-password')).statusCode, 400);
    assert.equal(
      (await h.app.inject({ method: 'POST', url: '/api/auth/recovery-codes', payload: { currentPassword: PASSWORD } }))
        .statusCode,
      401,
    );
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/recovery-codes' })).statusCode, 401);
  });

  it('아이디 없이 코드만으로 재설정 — 아이디를 알려 주고, 다른 기기는 끊기고, 남은 수를 준다', async () => {
    const user = await signup(h.app, '아이디잊음');
    const { codes } = (await issue(h, user)).json() as { codes: string[] };

    const res = await reset({ code: codes[0].toLowerCase().replace(/-/g, ' '), newPassword: 'recovered-pass-1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { token: string; user: { email: string; id: string }; recoveryCodesLeft: number };
    assert.equal(body.user.email, user.email);
    assert.equal(body.user.id, user.userId);
    assert.equal(body.recoveryCodesLeft, 9);
    assert.equal((await me(body.token)).statusCode, 200);
    assert.equal((await me(user.token)).statusCode, 401, '예전 토큰은 끊긴다(세대 올림)');

    const login = (password: string) =>
      h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password } });
    assert.equal((await login('recovered-pass-1')).statusCode, 200);
    assert.equal((await login(PASSWORD)).statusCode, 401);
  });

  it('같은 코드는 두 번 못 쓰고, 아이디를 함께 넣어도 된다', async () => {
    const user = await signup(h.app, '두번');
    const { codes } = (await issue(h, user)).json() as { codes: string[] };
    assert.equal((await reset({ code: codes[1], newPassword: 'first-use-123' })).statusCode, 200);
    assert.equal((await reset({ code: codes[1], newPassword: 'second-use-123' })).statusCode, 400);
    const withId = await reset({ username: user.email.toUpperCase(), code: codes[2], newPassword: 'with-id-1234' });
    assert.equal(withId.statusCode, 200, withId.body);
    assert.equal(withId.json().recoveryCodesLeft, 8);
  });

  it('남의 아이디 + 내 코드는 400 이고 그 코드는 쓰이지 않는다, 없는 아이디도 400', async () => {
    const owner = await signup(h.app, '주인');
    const other = await signup(h.app, '남');
    const { codes } = (await issue(h, owner)).json() as { codes: string[] };
    assert.equal((await reset({ email: other.email, code: codes[0], newPassword: 'not-yours-123' })).statusCode, 400);
    assert.equal((await reset({ email: 'nobody-here', code: codes[0], newPassword: 'nobody-1234' })).statusCode, 400);
    // 남이 넣어 본 뒤에도 주인은 그 코드를 그대로 쓴다.
    assert.equal((await status(owner)).json().remaining, 10);
    assert.equal((await reset({ email: owner.email, code: codes[0], newPassword: 'mine-after-1' })).statusCode, 200);
    // 남의 비밀번호는 그대로다.
    assert.equal(
      (await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: other.email, password: PASSWORD } }))
        .statusCode,
      200,
    );
  });

  it('다시 만들면 이전 묶음은 모두 못 쓴다', async () => {
    const user = await signup(h.app, '다시');
    const first = (await issue(h, user)).json() as { codes: string[] };
    const second = (await issue(h, user)).json() as { codes: string[] };
    assert.equal((await reset({ code: first.codes[0], newPassword: 'old-batch-12' })).statusCode, 400);
    assert.equal((await status(user)).json().remaining, 10);
    assert.equal((await reset({ code: second.codes[0], newPassword: 'new-batch-12' })).statusCode, 200);
  });

  it('운영자 코드는 아이디가 있어야 하고 recoveryCodesLeft 를 주지 않는다, 짧은 비밀번호는 400', async () => {
    const user = await signup(h.app, '운영자코드');
    const operator = issueResetCode(h.ctx.db, user.email)!;
    const noId = await reset({ code: operator.code, newPassword: 'operator-12' });
    assert.equal(noId.statusCode, 400);
    assert.match(noId.json().error.message, /아이디와 함께/);
    const ok = await reset({ email: user.email, code: operator.code, newPassword: 'operator-12' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().recoveryCodesLeft, undefined);

    const { codes } = (await issue(h, { ...user, token: ok.json().token }, 'operator-12')).json() as { codes: string[] };
    assert.equal((await reset({ code: codes[0], newPassword: 'short' })).statusCode, 400);
    assert.equal((await reset({ code: 'AAAA-BBBB-CCCC-DDD', newPassword: 'shape-wrong-1' })).statusCode, 400);
  });

  it('계정을 지우면 복구 코드도 함께 지워진다(FK cascade)', async () => {
    const user = await signup(h.app, '지움');
    await issue(h, user);
    h.ctx.db.prepare(`DELETE FROM users WHERE id = ?`).run(user.userId);
    const left = h.ctx.db
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`)
      .get(user.userId)!;
    assert.equal(left.n, 0);
  });
});

describe('복구 코드 — 대입 제한', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ loginFailureLimit: 5 });
  });
  after(async () => {
    await h.close();
  });

  it('틀린 복구 코드를 계속 넣으면(아이디 없이도) IP 기준으로 429', async () => {
    let last = 0;
    for (let i = 0; i < 7; i += 1) {
      last = (
        await h.app.inject({
          method: 'POST',
          url: '/api/auth/reset',
          payload: { code: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'guess-12345' },
        })
      ).statusCode;
    }
    assert.equal(last, 429);
    // 막힌 동안은 맞는 코드도 막힌다.
    const user = await signup(h.app, '막힘');
    const { codes } = (await issue(h, user)).json() as { codes?: string[] };
    assert.equal(codes, undefined, '복구 코드 만들기도 같은 IP 제한에 걸린다');
  });
});

describe('복구 코드 — 만들 때의 비밀번호 대입 제한', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ loginFailureLimit: 3 });
  });
  after(async () => {
    await h.close();
  });

  it('훔친 토큰으로 비밀번호를 맞혀 보면 429 로 막힌다', async () => {
    const user = await signup(h.app, '토큰도둑');
    let last = 0;
    for (let i = 0; i < 5; i += 1) last = (await issue(h, user, `guess-${i}-xxxx`)).statusCode;
    assert.equal(last, 429);
    assert.equal((await issue(h, user)).statusCode, 429, '막힌 동안은 맞는 비밀번호도');
  });
});
