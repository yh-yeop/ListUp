import { createHash, randomBytes } from 'node:crypto';
import {
  INVITE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
  parseRecoveryCode,
  type RecoveryCodesStatus,
} from '@listup/shared';
import type { Db } from '../db/index.ts';
import { newId } from '../lib/ids.ts';

/**
 * 복구 코드 — 본인이 「내 정보」에서 미리 만들어 두고, 비밀번호를 잊으면 운영자 없이 `/auth/reset` 에 넣는다.
 *
 * - 운영자 재설정 코드(services/password-reset.ts)는 30분짜리라 짧아도 되지만, 이것은 만료가 없어 16자(≈79비트).
 * - 한 사람 것이라 해시로 바로 찾는다 — 아이디를 잊었어도 코드만으로 그 계정을 연다(아이디 찾기).
 * - 한 번씩만 쓴다. 다시 만들면 이전 묶음은 모두 지운다. DB 에는 SHA-256 만 둔다.
 */

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

function newRecoveryCode(): string {
  // 모듈로 편향을 없애려 알파벳 크기 배수를 넘는 바이트는 버린다(lib/ids.ts newInviteCode 와 같다).
  const limit = Math.floor(256 / INVITE_ALPHABET.length) * INVITE_ALPHABET.length;
  let out = '';
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
      if (out.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return out;
}

/** 새 묶음을 만든다. 이전 것은 모두 못 쓰게 지운다. 원문(표시형)은 이 반환값에만 있다. */
export function issueRecoveryCodes(db: Db, userId: string, now = Date.now()): { codes: string[]; createdAt: number } {
  const codes: string[] = [];
  db.transaction(() => {
    db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`).run(userId);
    const insert = db.prepare(
      `INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)`,
    );
    while (codes.length < RECOVERY_CODE_COUNT) {
      const code = newRecoveryCode();
      // 79비트라 겹칠 일은 사실상 없지만, UNIQUE 에 걸려 묶음 전체가 실패하지 않게 미리 거른다.
      const hash = hashCode(code);
      if (db.prepare(`SELECT 1 FROM recovery_codes WHERE code_hash = ?`).get(hash)) continue;
      insert.run(newId('rec'), userId, hash, now);
      codes.push(formatRecoveryCode(code));
    }
  })();
  return { codes, createdAt: now };
}

export function recoveryCodesStatus(db: Db, userId: string): RecoveryCodesStatus {
  const row = db
    .prepare<[string], { total: number; remaining: number; created_at: number | null }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(used_at IS NULL), 0) AS remaining, MAX(created_at) AS created_at
       FROM recovery_codes WHERE user_id = ?`,
    )
    .get(userId)!;
  return { total: row.total, remaining: row.remaining, createdAt: row.created_at };
}

/** 입력이 복구 코드 모양인지 — `/auth/reset` 이 운영자 코드와 가르는 데 쓴다. */
export function looksLikeRecoveryCode(input: string): boolean {
  return parseRecoveryCode(input) !== null;
}

/**
 * 쓰지 않은 복구 코드면 쓴 것으로 표시하고 그 사용자 id 를, 아니면 null. 호출자의 트랜잭션 안에서 부른다.
 * 해시 열이 UNIQUE 색인이라 찾는 시간으로 코드를 맞혀 볼 수 없다(입력의 해시를 찾으므로 원문 비교가 없다).
 * `onlyUserId` 를 주면 그 사람의 코드일 때만 쓴다 — 아이디를 함께 넣었는데 남의 코드면 쓰지 않고 null.
 */
export function consumeRecoveryCode(db: Db, input: string, onlyUserId?: string, now = Date.now()): string | null {
  const code = parseRecoveryCode(input);
  if (!code) return null;
  const row = db
    .prepare<[string], { id: string; user_id: string }>(
      `SELECT id, user_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL`,
    )
    .get(hashCode(code));
  if (!row) return null;
  if (onlyUserId !== undefined && row.user_id !== onlyUserId) return null;
  db.prepare(`UPDATE recovery_codes SET used_at = ? WHERE id = ?`).run(now, row.id);
  return row.user_id;
}
