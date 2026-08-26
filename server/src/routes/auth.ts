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
import { badRequest, conflict, unauthorized } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { body, requireUser, requiredString } from '../lib/request.ts';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: number;
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
    };
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES (@id, @email, @password_hash, @display_name, @created_at)`,
    ).run(row);

    return reply.code(201).send({
      token: issueToken(row.id, config.authSecret, config.tokenTtlMs),
      user: toUser(row),
    });
  });

  app.post('/auth/login', async (req) => {
    const input = body(req);
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    // 이메일 존재 여부를 구분해 알려주지 않는다.
    const fail = () => unauthorized('이메일 또는 비밀번호가 올바르지 않습니다.');
    if (!email || !password) throw fail();

    const row = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE email = ?`).get(email);
    const ok = await verifyPassword(password, row ? row.password_hash : dummyHash);
    if (!row || !ok) throw fail();

    return {
      token: issueToken(row.id, config.authSecret, config.tokenTtlMs),
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
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(nextHash, user.id);
    return { ok: true };
  });
}
