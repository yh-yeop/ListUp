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
    assertLoginAllowed(keys);
    if (!email || !password) {
      for (const key of keys) loginLimiter.fail(key);
      throw fail();
    }

    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE email = ?`).get(email);
    const ok = await verifyPassword(password, row ? row.password_hash : dummyHash);
    if (!row || !ok) {
      for (const key of keys) loginLimiter.fail(key);
      throw fail();
    }
    for (const key of keys) loginLimiter.succeed(key);

    return {
      token: issueToken(row.id, config.authSecret, config.tokenTtlMs, row.token_epoch),
      user: toUser(row),
    };
  });

  /**
   * 재설정 코드로 새 비밀번호 — 서버 운영자가 발급한 코드(npm run reset-password)를 쓴다.
   * 성공하면 토큰 세대를 올려 다른 기기의 로그인을 끊고, 이 기기는 바로 로그인된다.
   * 틀린 시도는 로그인과 같은 제한으로 센다(코드 대입 방지).
   */
  app.post('/auth/reset', async (req) => {
    const input = body(req);
    const email = normalizeLoginId(input.username ?? input.email);
    const code = typeof input.code === 'string' ? input.code : '';
    const fail = () => badRequest('재설정 코드가 올바르지 않거나 만료됐습니다. 서버 운영자에게 다시 받아 주세요.');

    const keys = [`ip:${clientIp(req)}`, ...(email ? [`email:${email}`] : [])];
    assertLoginAllowed(keys);
    const next = validatePassword(input.newPassword);
    if (!next) throw badRequest(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);

    const row = email ? db.prepare<[string], UserRow>(`SELECT * FROM users WHERE email = ?`).get(email) : undefined;
    const nextHash = await hashPassword(next);
    const ok =
      row !== undefined &&
      db.transaction(() => {
        if (!consumeResetCode(db, row.id, code)) return false;
        db.prepare(`UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?`).run(nextHash, row.id);
        return true;
      })();
    if (!ok) {
      for (const key of keys) loginLimiter.fail(key);
      throw fail();
    }
    for (const key of keys) loginLimiter.succeed(key);

    const updated = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(row.id)!;
    return {
      token: issueToken(updated.id, config.authSecret, config.tokenTtlMs, updated.token_epoch),
      user: toUser(updated),
    };
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
    // 401 은 앱이 세션 만료로 해석해 로그아웃시키므로, 입력 오류인 이 경우는 400 으로 준다.
    if (!(await verifyPassword(current, row.password_hash))) {
      throw badRequest('현재 비밀번호가 올바르지 않습니다.');
    }
    const nextHash = await hashPassword(next);
    // 세대를 올려 다른 기기·유출된 토큰을 모두 끊는다. 지금 이 요청을 보낸 기기는
    // 새 토큰을 받아 이어서 쓴다(자기 자신을 로그아웃시키지 않는다).
    const epoch = row.token_epoch + 1;
    db.prepare(`UPDATE users SET password_hash = ?, token_epoch = ? WHERE id = ?`).run(
      nextHash,
      epoch,
      user.id,
    );
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
