import type {
  ChangeOp,
  Comment,
  Proposal,
  ProposalChange,
  ProposalStatus,
} from '@listup/shared';
import type { Db } from '../db/index.ts';
import { findPathConflict, readManifest, type EntryRow } from './snapshots.ts';

export interface ProposalRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  description: string;
  status: ProposalStatus;
  author_id: string;
  base_snapshot_id: string | null;
  merged_snapshot_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChangeRow {
  proposal_id: string;
  path: string;
  op: ChangeOp;
  blob_hash: string | null;
  size: number;
  mime_type: string | null;
  base_blob_hash: string | null;
  base_size: number | null;
}

export function getProposalRow(db: Db, proposalId: string): ProposalRow | undefined {
  return db.prepare<[string], ProposalRow>(`SELECT * FROM proposals WHERE id = ?`).get(proposalId);
}

export function readChanges(db: Db, proposalId: string): ChangeRow[] {
  return db
    .prepare<[string], ChangeRow>(
      `SELECT * FROM proposal_changes WHERE proposal_id = ? ORDER BY path`,
    )
    .all(proposalId);
}

export function toChange(row: ChangeRow): ProposalChange {
  return {
    path: row.path,
    op: row.op,
    blobHash: row.blob_hash,
    size: row.size,
    mimeType: row.mime_type,
    baseBlobHash: row.base_blob_hash,
    baseSize: row.base_size,
  };
}

export function toProposal(db: Db, row: ProposalRow): Proposal {
  const author = db
    .prepare<[string], { display_name: string }>(`SELECT display_name FROM users WHERE id = ?`)
    .get(row.author_id);
  const changeCount = db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM proposal_changes WHERE proposal_id = ?`,
    )
    .get(row.id)!.c;
  const commentCount = db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM proposal_comments WHERE proposal_id = ?`,
    )
    .get(row.id)!.c;

  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    author: { id: row.author_id, displayName: author?.display_name ?? '알 수 없음' },
    baseSnapshotId: row.base_snapshot_id,
    mergedSnapshotId: row.merged_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    changeCount,
    commentCount,
  };
}

export function readComments(db: Db, proposalId: string): Comment[] {
  const rows = db
    .prepare<[string], { id: string; author_id: string; body: string; created_at: number; display_name: string }>(
      `SELECT c.id, c.author_id, c.body, c.created_at, u.display_name
         FROM proposal_comments c JOIN users u ON u.id = c.author_id
        WHERE c.proposal_id = ?
        ORDER BY c.created_at`,
    )
    .all(proposalId);
  return rows.map((row) => ({
    id: row.id,
    author: { id: row.author_id, displayName: row.display_name },
    body: row.body,
    createdAt: row.created_at,
  }));
}

/**
 * 이 저장소에서 제안에 쓸 수 있는 blob 인지 — 이 저장소로 올렸거나(repo_blobs), 이 저장소의
 * 어떤 스냅샷에라도 들어 있던 것이어야 한다. blob 은 전역 콘텐츠 주소라 이 검사가 없으면
 * 해시만 알아내서 남의 저장소 파일을 제안 경유로 내려받을 수 있다.
 * (스냅샷 참조는 repo_blobs 가 생기기 전 데이터와, 지운 파일을 되살리는 제안을 위한 것)
 */
export function blobBelongsToRepo(db: Db, repoId: string, hash: string): boolean {
  const uploaded = db
    .prepare<[string, string], { ok: number }>(
      `SELECT 1 AS ok FROM repo_blobs WHERE repo_id = ? AND hash = ?`,
    )
    .get(repoId, hash);
  if (uploaded) return true;
  const referenced = db
    .prepare<[string, string], { ok: number }>(
      `SELECT 1 AS ok
         FROM snapshot_entries e JOIN snapshots s ON s.id = e.snapshot_id
        WHERE s.repo_id = ? AND e.blob_hash = ?
        LIMIT 1`,
    )
    .get(repoId, hash);
  return referenced !== undefined;
}

/** manifest 의 파일 크기 합. */
export function manifestBytes(manifest: Map<string, EntryRow>): number {
  let total = 0;
  for (const entry of manifest.values()) total += entry.size;
  return total;
}

/**
 * 추가(add) 항목이 manifest 의 기존 파일/폴더와 이름 공간이 겹치는지 — 겹치는 제안 경로들.
 * 수정·삭제는 이미 파일인 경로를 다루므로 볼 필요가 없다.
 */
export function findPathConflicts(
  manifest: Map<string, EntryRow>,
  changes: Pick<ChangeRow, 'path' | 'op'>[],
): string[] {
  const conflicts: string[] = [];
  for (const change of changes) {
    if (change.op !== 'add') continue;
    if (findPathConflict(manifest, change.path) !== null) conflicts.push(change.path);
  }
  return conflicts;
}

/**
 * 제안이 만들어진 시점(base) 이후에 head 에서 같은 파일이 바뀌었으면 충돌이다.
 * 3-way 자동 병합은 하지 않는다 — 바이너리 파일이 대부분이라 의미가 없고,
 * 사용자가 무엇이 덮어써지는지 알고 결정하게 하는 편이 안전하다.
 */
export function findConflicts(
  db: Db,
  changes: ChangeRow[],
  baseSnapshotId: string | null,
  headSnapshotId: string | null,
): string[] {
  if (baseSnapshotId === headSnapshotId) return [];
  const base = readManifest(db, baseSnapshotId);
  const head = readManifest(db, headSnapshotId);
  const conflicts: string[] = [];

  for (const change of changes) {
    const baseHash = base.get(change.path)?.blob_hash ?? null;
    const headHash = head.get(change.path)?.blob_hash ?? null;
    if (baseHash === headHash) continue;
    // head 가 이미 제안과 똑같은 상태라면 충돌이 아니라 이미 반영된 것이다.
    if (headHash === change.blob_hash) continue;
    conflicts.push(change.path);
  }
  return conflicts;
}

/** 제안 내용을 head manifest 에 적용한 결과를 만든다. */
export function applyChanges(
  head: Map<string, EntryRow>,
  changes: ChangeRow[],
  now: number,
): Map<string, EntryRow> {
  const merged = new Map(head);
  for (const change of changes) {
    if (change.op === 'delete') {
      merged.delete(change.path);
      continue;
    }
    merged.set(change.path, {
      path: change.path,
      blob_hash: change.blob_hash!,
      size: change.size,
      mime_type: change.mime_type ?? 'application/octet-stream',
      updated_at: now,
    });
  }
  return merged;
}
