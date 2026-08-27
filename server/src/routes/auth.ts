import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { User } from '@listup/shared';
import { MAX_NAME_LENGTH } from '@listup/shared';
import type { AppContext } from '../context.ts';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  issueToken,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from '../lib/auth.ts';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { newId } from '../lib/ids.ts';
import { body, requireUser, requiredString } from '../lib/request.ts';

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
  /** 프록시 뒤에서는 trustProxy 설정이 켜져 있어야 실제 IP 가 들어온다. */
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
    const email = normalizeEmail(input.email);
    if (!email) throw badRequest('이메일 형식이 올바르지 않습니다.');
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
    if (existing) throw conflict('이미 가입된 이메일입니다.');

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
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    // 이메일 존재 여부를 구분해 알려주지 않는다.
    const fail = () => unauthorized('이메일 또는 비밀번호가 올바르지 않습니다.');

    // 이메일이 형식조차 아니면 IP 만 센다 — 없는 이메일로 카운터를 늘리게 두지 않는다.
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
}
