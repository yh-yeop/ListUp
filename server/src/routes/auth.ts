import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { User } from '@listup/shared';
import { LOGIN_ID_RULE, MAX_NAME_LENGTH } from '@listup/shared';
import type { AppContext } from '../context.ts';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  issueToken,
  normalizeLoginId,
  validateNewLoginId,
  validatePassword,
  verifyPassword,
} from '../lib/auth.ts';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { newId } from '../lib/ids.ts';
import { body, requireUser, requiredString } from '../lib/request.ts';
import { consumeResetCode } from '../services/password-reset.ts';
import {
  consumeRecoveryCode,
  issueRecoveryCodes,
  looksLikeRecoveryCode,
  recoveryCodesStatus,
} from '../services/recovery-codes.ts';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: number;
  token_epoch: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;
  // 없는 이메일로 로그인할 때도 이 해시를 검증해, 응답 시간으로 가입 여부를 알 수 없게 한다.
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'));

  // 비밀번호 대입 공격 제한. 계정 하나를 노리는 경우(이메일 기준)와 여러 계정을 훑는
  // 경우(IP 기준)를 따로 센다. 성공하면 그 키의 기록은 지운다.
  const loginLimiter = new RateLimiter({
    limit: config.loginFailureLimit,
    windowMs: config.loginFailureWindowMs,
    blockMs: config.loginBlockMs,
  });
  /** 터널 뒤에서는 믿을 프록시(`trustProxy`, 기본 루프백)가 준 X-Forwarded-For 의 IP 가 들어온다. */
  const clientIp = (req: { ip: string }) => req.ip || 'unknown';

  function assertLoginAllowed(keys: string[]): void {
    for (const key of keys) {
      const verdict = loginLimiter.check(key);
      if (!verdict.allowed) {
        throw tooManyRequests(
          `로그인 시도가 너무 많습니다. ${verdict.retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }
    }
  }

  /**
   * 비밀번호·코드를 확인하기 **전에** 시도를 실패로 먼저 센다 — 맞으면 `attemptSucceeded` 가 지운다.
   * 확인(scrypt)이 비동기라, 확인 뒤에 세면 한꺼번에 보낸 요청이 모두 검사를 통과한 다음에야 실패가 쌓인다
   * (한도 3 이어도 동시에 수백 개를 맞혀 볼 수 있었다 — test/auth-race.test.ts). 검사와 기록이 같은 틱이라 끼어들 틈이 없다.
   */
  function beginAttempt(keys: string[]): void {
    assertLoginAllowed(keys);
    for (const key of keys) loginLimiter.fail(key);
  }
  function attemptSucceeded(keys: string[]): void {
    for (const key of keys) loginLimiter.succeed(key);
  }

  app.post('/auth/signup', async (req, reply) => {
    const input = body(req);
    // 필드 이름은 호환을 위해 email 이지만 로그인 아이디다(lib/auth.ts). 새 앱은 username 으로도 보낼 수 있다.
    const email = validateNewLoginId(input.username ?? input.email);
    if (!email) throw badRequest(`아이디는 ${LOGIN_ID_RULE} 으로 정해 주세요.`);
    const password = validatePassword(input.password);
    if (!password) {
      throw badRequest(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    }
    const displayName = requiredString(input, 'displayName', {
      max: MAX_NAME_LENGTH,
      label: '이름',
    });

    const existing = db
      .prepare<[string], { id: string }>(`SELECT id FROM users WHERE email = ?`)
      .get(email);
    if (existing) throw conflict('이미 쓰고 있는 아이디입니다.');

    const row: UserRow = {
      id: newId('usr'),
      email,
      password_hash: await hashPassword(password),
      display_name: displayName,
      created_at: Date.now(),
      token_epoch: 0,
    };
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES (@id, @email, @password_hash, @display_name, @created_at)`,
    ).run(row);

    return reply.code(201).send({
      token: issueToken(row.id, config.authSecret, config.tokenTtlMs, row.token_epoch),
      user: toUser(row),
    });
  });

  app.post('/auth/login', async (req) => {
    const input = body(req);
    const email = normalizeLoginId(input.username ?? input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    // 아이디 존재 여부를 구분해 알려주지 않는다.
    const fail = () => unauthorized('아이디 또는 비밀번호가 올바르지 않습니다.');

    // 아이디가 모양조차 아니면 IP 만 센다 — 엉터리 아이디로 카운터를 늘리게 두지 않는다.
    const keys = [`ip:${clientIp(req)}`, ...(email ? [`email:${email}`] : [])];
    beginAttempt(keys);
    if (!email || !password) throw fail();

    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE email = ?`).get(email);
    const ok = await verifyPassword(password, row ? row.password_hash : dummyHash);
    if (!row || !ok) throw fail();
    attemptSucceeded(keys);

    return {
      token: issueToken(row.id, config.authSecret, config.tokenTtlMs, row.token_epoch),
      user: toUser(row),
    };
  });

  /**
   * 코드로 새 비밀번호 — 두 가지 코드를 받는다.
   * - 운영자 재설정 코드(`ABCDE-12345`, npm run reset-password·PC 앱이 발급, 30분): 아이디와 함께.
   * - 본인 복구 코드(`ABCD-EFGH-JKMN-PQRS`, 「내 정보」에서 미리 만든 것, API_LEVEL 7): 아이디 없이도 된다 —
   *   코드가 그 사람을 가리키므로 아이디를 잊었을 때도 쓴다(응답의 user.email 이 아이디). 아이디를 함께 주면
   *   그 사람의 코드일 때만 된다.
   * 성공하면 토큰 세대를 올려 다른 기기의 로그인을 끊고, 이 기기는 바로 로그인된다.
   * 틀린 시도는 로그인과 같은 제한으로 센다(코드 대입 방지). 어떤 경우든 실패 문구는 같다.
   */
  app.post('/auth/reset', async (req) => {
    const input = body(req);
    const email = normalizeLoginId(input.username ?? input.email);
    const code = typeof input.code === 'string' ? input.code : '';
    const recovery = looksLikeRecoveryCode(code);
    const fail = () =>
      badRequest(
        recovery
          ? '복구 코드가 올바르지 않거나 이미 쓴 코드입니다. 다른 복구 코드를 넣거나 서버 운영자에게 재설정 코드를 받아 주세요.'
          : '재설정 코드가 올바르지 않거나 만료됐습니다. 서버 운영자에게 다시 받아 주세요.',
      );

    const keys = [`ip:${clientIp(req)}`, ...(email ? [`email:${email}`] : [])];
    assertLoginAllowed(keys);
    const next = validatePassword(input.newPassword);
    if (!next) throw badRequest(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    // 운영자 코드는 누구 것인지 아이디로만 안다. 모양 검사라 실패로 세지 않는다.
    if (!recovery && !email) throw badRequest('서버 운영자에게 받은 재설정 코드는 아이디와 함께 넣어 주세요.');
    beginAttempt(keys);

    const row = email ? db.prepare<[string], UserRow>(`SELECT * FROM users WHERE email = ?`).get(email) : undefined;
    const nextHash = await hashPassword(next);
    const userId = db.transaction((): string | null => {
      let id: string | null;
      if (recovery) {
        // 아이디를 줬는데 없는 계정이면 어떤 코드든 실패 — 남의 코드로 들어가지 않게.
        if (email && !row) return null;
        id = consumeRecoveryCode(db, code, row?.id);
      } else {
        id = row && consumeResetCode(db, row.id, code) ? row.id : null;
      }
      if (!id) return null;
      db.prepare(`UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?`).run(nextHash, id);
      return id;
    })();
    if (!userId) throw fail();
    attemptSucceeded(keys);

    const updated = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(userId)!;
    return {
      token: issueToken(updated.id, config.authSecret, config.tokenTtlMs, updated.token_epoch),
      user: toUser(updated),
      ...(recovery ? { recoveryCodesLeft: recoveryCodesStatus(db, updated.id).remaining } : {}),
    };
  });

  /** 복구 코드가 남았는지 — 원문은 다시 보여주지 않는다 (API_LEVEL 7). */
  app.get('/auth/recovery-codes', async (req) => {
    const user = requireUser(req);
    return recoveryCodesStatus(db, user.id);
  });

  /**
   * 복구 코드를 새로 만든다 — 현재 비밀번호를 다시 확인한다(잠깐 비운 기기에서 남이 만들어 가지 못하게).
   * 이전 묶음은 모두 못 쓰게 된다. 틀린 비밀번호는 로그인과 같은 제한으로 센다 — 훔친 토큰으로 비밀번호를
   * 맞혀 보는 창구가 되지 않게. 원문은 이 응답에만 있다.
   */
  app.post('/auth/recovery-codes', async (req, reply) => {
    const user = requireUser(req);
    const input = body(req);
    const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(user.id)!;
    const keys = [`ip:${clientIp(req)}`, `email:${row.email}`];
    beginAttempt(keys);
    // 401 은 앱이 로그아웃으로 해석하므로 /auth/password 처럼 400.
    if (!(await verifyPassword(current, row.password_hash))) {
      throw badRequest('현재 비밀번호가 올바르지 않습니다.');
    }
    attemptSucceeded(keys);
    return reply.code(201).send(issueRecoveryCodes(db, user.id));
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(user.id)!;
    return { user: toUser(row) };
  });

  app.patch('/auth/me', async (req) => {
    const user = requireUser(req);
    const input = body(req);
    const displayName = requiredString(input, 'displayName', {
      max: MAX_NAME_LENGTH,
      label: '이름',
    });
    db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName, user.id);
    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(user.id)!;
    return { user: toUser(row) };
  });

  app.post('/auth/password', async (req) => {
    const user = requireUser(req);
    const input = body(req);
    const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const next = validatePassword(input.newPassword);
    if (!next) throw badRequest(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);

    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(user.id)!;
    // 현재 비밀번호 확인도 로그인과 같은 제한으로 센다 — 훔친 토큰으로 비밀번호를 맞혀 보는 창구가 되지 않게
    // (복구 코드 만들기는 막는데 여기가 열려 있으면 소용없었다, 2026-11-21 검토).
    const keys = [`ip:${clientIp(req)}`, `email:${row.email}`];
    beginAttempt(keys);
    // 401 은 앱이 세션 만료로 해석해 로그아웃시키므로, 입력 오류인 이 경우는 400 으로 준다.
    if (!(await verifyPassword(current, row.password_hash))) {
      throw badRequest('현재 비밀번호가 올바르지 않습니다.');
    }
    attemptSucceeded(keys);
    const nextHash = await hashPassword(next);
    // 세대를 올려 다른 기기·유출된 토큰을 모두 끊는다. 지금 이 요청을 보낸 기기는
    // 새 토큰을 받아 이어서 쓴다(자기 자신을 로그아웃시키지 않는다). 해시를 기다리는 동안 다른 요청이 세대를
    // 올렸을 수 있으니 읽어 둔 값이 아니라 DB 에서 올린다.
    const epoch = db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?`).run(nextHash, user.id);
      return db.prepare<[string], { token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = ?`).get(user.id)!
        .token_epoch;
    })();
    return { ok: true, token: issueToken(user.id, config.authSecret, config.tokenTtlMs, epoch) };
  });

  /**
   * 로그아웃 — 이 요청에 쓴 토큰만 끊는다. 토큰은 서버에 저장하지 않으므로, 앱이 지우기만 하면 복사된
   * 토큰이 만료까지 살아 있었다. 끊은 토큰의 해시를 만료 시각까지 적어 두고 GC 가 지운다.
   */
  app.post('/auth/logout', async (req) => {
    const user = requireUser(req);
    db.prepare(
      `INSERT OR IGNORE INTO revoked_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
    ).run(user.token.hash, user.id, user.token.exp);
    return { ok: true };
  });

  /**
   * 다른 기기 모두 로그아웃 — 세대를 올려 이 사용자의 토큰과 다운로드 링크를 한 번에 끊는다(비밀번호 변경과
   * 같은 방식). 이 기기는 새 토큰을 받아 이어서 쓴다. 비밀번호를 저장해 둔 기기는 그 비밀번호로 다시
   * 들어오므로, 기기를 잃어버렸다면 비밀번호를 바꿔야 한다 — 앱이 그렇게 안내한다.
   */
  app.post('/auth/logout-others', async (req) => {
    const user = requireUser(req);
    const epoch = db.transaction(() => {
      db.prepare(`UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?`).run(user.id);
      // 세대가 바뀌면 적어 둔 토큰은 어차피 통과하지 못한다.
      db.prepare(`DELETE FROM revoked_tokens WHERE user_id = ?`).run(user.id);
      return db.prepare<[string], { token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = ?`).get(user.id)!
        .token_epoch;
    })();
    return { token: issueToken(user.id, config.authSecret, config.tokenTtlMs, epoch) };
  });
}
