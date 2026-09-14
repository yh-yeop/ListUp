import { createHash, timingSafeEqual } from 'node:crypto';
import { formatInviteCode, parseInviteCode } from '@listup/shared';
import type { Db } from '../db/index.ts';
import { newId, newInviteCode } from '../lib/ids.ts';

/**
 * 비밀번호 재설정 코드 — **서버를 돌리는 사람이** 발급한다(`npm run reset-password -- <이메일>`).
 *
 * 계정은 서버마다 따로라 비밀번호를 잊으면 그 서버에서만 풀면 된다. 이메일을 보낼 수단(SMTP)이 없는
 * 자가호스팅 도구라, 초대 코드를 건네던 것과 같은 길(운영자 → 본인, 메신저 등)로 코드를 건넨다.
 * 저장소 소유자는 서버 운영자가 아니므로(다른 저장소에도 속한 남의 계정을 풀면 안 된다) 앱에서는
 * 발급하지 않는다.
 *
 * - 초대 코드와 같은 알파벳·길이(헷갈리는 글자 없음, 불러 주기 쉬움). DB 에는 해시만 둔다.
 * - 30분 뒤 만료, 한 번만 쓴다. 새로 발급하면 그 사람의 이전 코드는 쓸 수 없다.
 */

export const RESET_CODE_TTL_MS = 30 * 60 * 1000;

const hashCode = (code: string) => createHash('sha256').update(code).digest();

/** 코드를 발급한다. 없는 이메일이면 null. */
export function issueResetCode(db: Db, email: string, now = Date.now()): { code: string; expiresAt: number } | null {
  const user = db.prepare<[string], { id: string }>(`SELECT id FROM users WHERE email = ?`).get(email);
  if (!user) return null;
  const code = newInviteCode();
  const expiresAt = now + RESET_CODE_TTL_MS;
  db.transaction(() => {
    // 이전에 발급한 쓰지 않은 코드는 끝낸다 — 가장 최근 코드만 쓸 수 있다.
    db.prepare(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, user.id);
    db.prepare(
      `INSERT INTO password_resets (id, user_id, code_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(newId('pwr'), user.id, hashCode(code).toString('hex'), expiresAt, now);
  })();
  return { code: formatInviteCode(code), expiresAt };
}

/**
 * 코드가 맞으면 그 코드를 쓴 것으로 표시하고 true. 호출자의 트랜잭션 안에서 부른다.
 * 입력은 하이픈·공백·소문자를 섞어도 된다.
 */
export function consumeResetCode(db: Db, userId: string, input: string, now = Date.now()): boolean {
  const code = parseInviteCode(input);
  if (!code) return false;
  const rows = db
    .prepare<[string, number], { id: string; code_hash: string }>(
      `SELECT id, code_hash FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .all(userId, now);
  const given = hashCode(code);
  const match = rows.find((row) => {
    const stored = Buffer.from(row.code_hash, 'hex');
    return stored.length === given.length && timingSafeEqual(stored, given);
  });
  if (!match) return false;
  db.prepare(`UPDATE password_resets SET used_at = ? WHERE id = ?`).run(now, match.id);
  return true;
}
