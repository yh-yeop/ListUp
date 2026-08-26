import type { DirEntry, FileEntry, Snapshot, TreeListing } from '@listup/shared';
import { baseName } from '@listup/shared';
import type { Db } from '../db/index.ts';
import { newId } from '../lib/ids.ts';

export interface EntryRow {
  path: string;
  blob_hash: string;
  size: number;
  mime_type: string;
  updated_at: number;
}

/** 스냅샷의 전체 파일 목록을 경로 기준 Map 으로. */
export function readManifest(db: Db, snapshotId: string | null): Map<string, EntryRow> {
  const manifest = new Map<string, EntryRow>();
  if (!snapshotId) return manifest;
  const rows = db
    .prepare<[string], EntryRow>(
      `SELECT path, blob_hash, size, mime_type, updated_at
         FROM snapshot_entries WHERE snapshot_id = ?`,
    )
    .all(snapshotId);
  for (const row of rows) manifest.set(row.path, row);
  return manifest;
}

/**
 * 새 파일 경로가 기존 항목의 이름 공간과 겹치는지 찾는다 — 파일과 폴더는 같은 이름을 가질 수 없다.
 * - `path/` 아래에 항목이 있으면(= path 는 이미 폴더) 그 항목의 경로를,
 * - path 의 조상 경로가 파일로 존재하면 그 조상 경로를 돌려준다.
 * 겹치지 않으면 null. path 자신이 파일로 있는 경우는 덮어쓰기이므로 여기서 보지 않는다.
 * 돌려준 값이 `${path}/` 로 시작하면 앞의 경우, 아니면 뒤의 경우다.
 */
export function findPathConflict(manifest: Map<string, EntryRow>, path: string): string | null {
  const prefix = `${path}/`;
  for (const key of manifest.keys()) {
    if (key.startsWith(prefix)) return key;
  }
  for (let idx = path.indexOf('/'); idx !== -1; idx = path.indexOf('/', idx + 1)) {
    const ancestor = path.slice(0, idx);
    if (manifest.has(ancestor)) return ancestor;
  }
  return null;
}

export interface CreateSnapshotInput {
  repoId: string;
  parentId: string | null;
  authorId: string;
  message: string;
  manifest: Map<string, EntryRow>;
  now?: number;
}

/**
 * 새 스냅샷을 기록하고 저장소 head 를 옮긴다.
 * 호출자가 트랜잭션을 열어둔 상태에서 부르는 것을 전제로 한다.
 */
export function writeSnapshot(db: Db, input: CreateSnapshotInput): string {
  const now = input.now ?? Date.now();
  const id = newId('snap');

  db.prepare(
    `INSERT INTO snapshots (id, repo_id, parent_id, message, author_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.repoId, input.parentId, input.message, input.authorId, now);

  const insertEntry = db.prepare(
    `INSERT INTO snapshot_entries (snapshot_id, path, blob_hash, size, mime_type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of input.manifest.values()) {
    insertEntry.run(id, entry.path, entry.blob_hash, entry.size, entry.mime_type, entry.updated_at);
  }

  db.prepare(`UPDATE repos SET head_snapshot_id = ?, updated_at = ? WHERE id = ?`).run(
    id,
    now,
    input.repoId,
  );

  return id;
}

export interface SnapshotStats {
  fileCount: number;
  totalSize: number;
}

export function snapshotStats(db: Db, snapshotId: string | null): SnapshotStats {
  if (!snapshotId) return { fileCount: 0, totalSize: 0 };
  const row = db
    .prepare<[string], { file_count: number; total_size: number | null }>(
      `SELECT COUNT(*) AS file_count, SUM(size) AS total_size
         FROM snapshot_entries WHERE snapshot_id = ?`,
    )
    .get(snapshotId);
  return { fileCount: row?.file_count ?? 0, totalSize: row?.total_size ?? 0 };
}

function toFileEntry(row: EntryRow): FileEntry {
  return {
    path: row.path,
    name: baseName(row.path),
    blobHash: row.blob_hash,
    size: row.size,
    mimeType: row.mime_type,
    updatedAt: row.updated_at,
  };
}

/**
 * 스냅샷은 평평한 경로 목록이므로, 디렉터리는 조회 시점에 접두사로 만들어 낸다.
 * (빈 디렉터리는 존재하지 않는다 — git 과 같은 방식)
 */
export function listTree(db: Db, snapshotId: string | null, dirPath: string): TreeListing {
  const listing: TreeListing = { path: dirPath, snapshotId, dirs: [], files: [] };
  if (!snapshotId) return listing;

  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const manifest = readManifest(db, snapshotId);
  const dirs = new Map<string, DirEntry>();

  for (const row of manifest.values()) {
    if (prefix && !row.path.startsWith(prefix)) continue;
    const rest = row.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      listing.files.push(toFileEntry(row));
      continue;
    }
    const name = rest.slice(0, slash);
    const childPath = `${prefix}${name}`;
    const dir = dirs.get(name) ?? { name, path: childPath, fileCount: 0, totalSize: 0 };
    dir.fileCount += 1;
    dir.totalSize += row.size;
    dirs.set(name, dir);
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, 'ko', { numeric: true });
  listing.dirs = [...dirs.values()].sort(byName);
  listing.files.sort(byName);
  return listing;
}

interface SnapshotRow {
  id: string;
  repo_id: string;
  parent_id: string | null;
  message: string;
  author_id: string;
  created_at: number;
  display_name: string;
  file_count: number;
  total_size: number | null;
}

/** 변경 이력 페이지 커서. 같은 밀리초에 만들어진 스냅샷을 건너뛰지 않도록 id 까지 본다. */
export interface SnapshotCursor {
  before: number;
  beforeId: string;
}

export function listSnapshots(
  db: Db,
  repoId: string,
  limit: number,
  cursor?: SnapshotCursor,
): Snapshot[] {
  const before = cursor?.before ?? Number.MAX_SAFE_INTEGER;
  const beforeId = cursor?.beforeId ?? '';
  const rows = db
    .prepare<[string, number, number, string, number], SnapshotRow>(
      `SELECT s.*, u.display_name,
              (SELECT COUNT(*) FROM snapshot_entries e WHERE e.snapshot_id = s.id) AS file_count,
              (SELECT SUM(size) FROM snapshot_entries e WHERE e.snapshot_id = s.id) AS total_size
         FROM snapshots s
         JOIN users u ON u.id = s.author_id
        WHERE s.repo_id = ?
          AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?`,
    )
    .all(repoId, before, before, beforeId, limit);

  return rows.map((row) => ({
    id: row.id,
    repoId: row.repo_id,
    parentId: row.parent_id,
    message: row.message,
    authorId: row.author_id,
    author: { id: row.author_id, displayName: row.display_name },
    createdAt: row.created_at,
    fileCount: row.file_count,
    totalSize: row.total_size ?? 0,
  }));
}

/** 이 스냅샷이 저장소에 실제로 속하는지 확인한다. */
export function snapshotBelongsTo(db: Db, snapshotId: string, repoId: string): boolean {
  const row = db
    .prepare<[string, string], { id: string }>(`SELECT id FROM snapshots WHERE id = ? AND repo_id = ?`)
    .get(snapshotId, repoId);
  return row !== undefined;
}
