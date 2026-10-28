/**
 * 저장소 활동 기록 — 멤버·초대 변화. 파일 변경은 스냅샷이 기록이므로 여기에 두지 않는다.
 * 기록은 그 변화를 만든 트랜잭션 안에서 남긴다(변화는 됐는데 기록이 빠지는 일이 없게).
 */
import type { RepoEvent, RepoEventKind, Role } from '@listup/shared';
import { isRole } from '@listup/shared';
import type { Db } from '../db/index.ts';

export interface EventInput {
  kind: RepoEventKind;
  actorId: string | null;
  targetId?: string | null;
  role?: Role | null;
  inviteId?: string | null;
}

export function recordEvent(db: Db, repoId: string, event: EventInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO repo_events (repo_id, kind, actor_id, target_id, role, invite_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repoId,
    event.kind,
    event.actorId,
    event.targetId ?? null,
    event.role ?? null,
    event.inviteId ?? null,
    now,
  );
}

interface EventRow {
  seq: number;
  kind: string;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  role: string | null;
  created_at: number;
}

/** 최근 것부터. `before` 는 이전 페이지의 마지막 seq. */
export function listEvents(db: Db, repoId: string, limit: number, before?: number): RepoEvent[] {
  const rows = db
    .prepare<[string, number, number], EventRow>(
      `SELECT e.seq, e.kind, e.actor_id, a.display_name AS actor_name,
              e.target_id, t.display_name AS target_name, e.role, e.created_at
         FROM repo_events e
         LEFT JOIN users a ON a.id = e.actor_id
         LEFT JOIN users t ON t.id = e.target_id
        WHERE e.repo_id = ? AND e.seq < ?
        ORDER BY e.seq DESC
        LIMIT ?`,
    )
    .all(repoId, before ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind,
    actor: row.actor_id ? { id: row.actor_id, displayName: row.actor_name ?? '알 수 없음' } : null,
    target: row.target_id ? { id: row.target_id, displayName: row.target_name ?? '알 수 없음' } : null,
    role: isRole(row.role) ? row.role : null,
    createdAt: row.created_at,
  }));
}
