import type { Member, Repo, RepoSummary, Role } from '@listup/shared';
import { hasRole } from '@listup/shared';
import type { Db } from '../db/index.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { snapshotStats } from './snapshots.ts';

export interface RepoRow {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  head_snapshot_id: string | null;
  proposal_seq: number;
  created_at: number;
  updated_at: number;
}

export function getRepoRow(db: Db, repoId: string): RepoRow | undefined {
  return db.prepare<[string], RepoRow>(`SELECT * FROM repos WHERE id = ?`).get(repoId);
}

export function getRole(db: Db, repoId: string, userId: string): Role | null {
  const row = db
    .prepare<[string, string], { role: Role }>(
      `SELECT role FROM repo_members WHERE repo_id = ? AND user_id = ?`,
    )
    .get(repoId, userId);
  return row?.role ?? null;
}

export interface RepoAccess {
  repo: RepoRow;
  role: Role;
}

/**
 * 저장소 접근 확인. 멤버가 아니면 존재 자체를 숨기기 위해 404 를 준다
 * (저장소 ID 를 대입해가며 존재 여부를 알아내는 것을 막는다).
 */
export function requireAccess(db: Db, repoId: string, userId: string, required: Role): RepoAccess {
  const repo = getRepoRow(db, repoId);
  if (!repo) throw notFound('저장소를 찾을 수 없습니다.');
  const role = getRole(db, repoId, userId);
  if (!role) throw notFound('저장소를 찾을 수 없습니다.');
  if (!hasRole(role, required)) {
    throw forbidden(
      required === 'owner'
        ? '저장소 소유자만 할 수 있습니다.'
        : '편집 권한이 없습니다. 대신 변경 제안을 올릴 수 있습니다.',
    );
  }
  return { repo, role };
}

export function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id,
    headSnapshotId: row.head_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRepoSummary(db: Db, row: RepoRow, role: Role): RepoSummary {
  const stats = snapshotStats(db, row.head_snapshot_id);
  const owner = db
    .prepare<[string], { id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE id = ?`,
    )
    .get(row.owner_id);
  const memberCount = db
    .prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM repo_members WHERE repo_id = ?`)
    .get(row.id)!.c;
  const openProposalCount = db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM proposals WHERE repo_id = ? AND status = 'open'`,
    )
    .get(row.id)!.c;

  return {
    ...toRepo(row),
    role,
    owner: { id: row.owner_id, displayName: owner?.display_name ?? '알 수 없음' },
    fileCount: stats.fileCount,
    totalSize: stats.totalSize,
    memberCount,
    openProposalCount,
  };
}

export function listMembers(db: Db, repoId: string, viewerRole: Role): Member[] {
  const rows = db
    .prepare<[string], { user_id: string; role: Role; joined_at: number; display_name: string; email: string }>(
      `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.email
         FROM repo_members m JOIN users u ON u.id = m.user_id
        WHERE m.repo_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at`,
    )
    .all(repoId);

  // 이메일은 소유자에게만 보여준다.
  const showEmail = viewerRole === 'owner';
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: showEmail ? row.email : null,
    role: row.role,
    joinedAt: row.joined_at,
  }));
}
