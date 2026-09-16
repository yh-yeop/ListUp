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

/**
 * 저장 구조 (마이그레이션 v5)
 *
 * - repo_files: 저장소의 지금 파일 목록(head).
 * - snapshot_changes: 스냅샷이 바꾼 경로만, 앞뒤 값과 함께.
 *
 * 커밋은 바뀐 경로만 적으므로 파일 수와 무관하다. 과거 시점은 head 에서 시작해 그 뒤의 스냅샷들이
 * 바꾼 것을 최근 것부터 앞의 값으로 되돌려 만든다 — 과거 보기는 드물고, 되돌리는 양은 그 시점
 * 이후의 변경 수만큼이다. 스냅샷은 늘 그때의 head 위에 쌓이므로 이력은 갈라지지 않는다.
 */

interface ChangeRow {
  path: string;
  blob_hash: string | null;
  size: number | null;
  mime_type: string | null;
  updated_at: number | null;
  prev_blob_hash: string | null;
  prev_size: number | null;
  prev_mime_type: string | null;
  prev_updated_at: number | null;
}

/** 저장소의 지금 파일 목록. */
function readHead(db: Db, repoId: string): Map<string, EntryRow> {
  const manifest = new Map<string, EntryRow>();
  const rows = db
    .prepare<[string], EntryRow>(
      `SELECT path, blob_hash, size, mime_type, updated_at FROM repo_files WHERE repo_id = ?`,
    )
    .all(repoId);
  for (const row of rows) manifest.set(row.path, row);
  return manifest;
}

/** 스냅샷의 전체 파일 목록을 경로 기준 Map 으로. head 가 아니면 head 에서 되돌려 만든다. */
export function readManifest(db: Db, snapshotId: string | null): Map<string, EntryRow> {
  if (!snapshotId) return new Map();
  const target = db
    .prepare<[string], { repo_id: string; head: string | null }>(
      `SELECT s.repo_id, r.head_snapshot_id AS head
         FROM snapshots s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?`,
    )
    .get(snapshotId);
  if (!target) return new Map();

  const manifest = readHead(db, target.repo_id);
  if (target.head === snapshotId) return manifest;

  // head 부터 부모를 따라 내려가며, 목표 스냅샷에 닿기 전까지의 스냅샷을 최근 것부터 모은다.
  const newer = db
    .prepare<[string | null, string], { id: string; depth: number }>(
      `WITH RECURSIVE chain(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM snapshots WHERE id = ?
         UNION ALL
         SELECT s.id, s.parent_id, c.depth + 1
           FROM snapshots s JOIN chain c ON s.id = c.parent_id
          WHERE c.id <> ?
       )
       SELECT id, depth FROM chain ORDER BY depth`,
    )
    .all(target.head, snapshotId);
  if (newer.at(-1)?.id !== snapshotId) {
    throw new Error(`스냅샷 ${snapshotId} 이 저장소 이력(head 에서 부모를 따라간 줄)에 없습니다.`);
  }

  const changesOf = db.prepare<[string], ChangeRow>(`SELECT * FROM snapshot_changes WHERE snapshot_id = ?`);
  for (const { id } of newer.slice(0, -1)) {
    for (const change of changesOf.all(id)) {
      if (change.prev_blob_hash === null) {
        manifest.delete(change.path);
      } else {
        manifest.set(change.path, {
          path: change.path,
          blob_hash: change.prev_blob_hash,
          size: change.prev_size!,
          mime_type: change.prev_mime_type!,
          updated_at: change.prev_updated_at!,
        });
      }
    }
  }
  return manifest;
}

/** 스냅샷 시점의 한 파일. head 면 목록 전체를 만들지 않고 바로 찾는다. */
export function readEntry(db: Db, snapshotId: string, path: string): EntryRow | undefined {
  const head = db
    .prepare<[string, string], EntryRow>(
      `SELECT f.path, f.blob_hash, f.size, f.mime_type, f.updated_at
         FROM snapshots s
         JOIN repos r ON r.id = s.repo_id AND r.head_snapshot_id = s.id
         JOIN repo_files f ON f.repo_id = s.repo_id AND f.path = ?
        WHERE s.id = ?`,
    )
    .get(path, snapshotId);
  if (head) return head;
  const isHead = db
    .prepare<[string], { ok: number }>(
      `SELECT 1 AS ok FROM snapshots s JOIN repos r ON r.head_snapshot_id = s.id WHERE s.id = ?`,
    )
    .get(snapshotId);
  if (isHead) return undefined;
  return readManifest(db, snapshotId).get(path);
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
 * 새 스냅샷을 기록하고 저장소 head 를 옮긴다. manifest 는 커밋 뒤의 **전체** 목록이다 —
 * 지금 목록(repo_files)과 견줘 바뀐 경로만 적는다.
 * 호출자가 트랜잭션을 열어둔 상태에서, 트랜잭션 안에서 읽은 head 를 parentId 로 부르는 것을 전제로 한다.
 */
export function writeSnapshot(db: Db, input: CreateSnapshotInput): string {
  const now = input.now ?? Date.now();
  const id = newId('snap');
  const current = readHead(db, input.repoId);

  let totalSize = 0;
  for (const entry of input.manifest.values()) totalSize += entry.size;

  db.prepare(
    `INSERT INTO snapshots (id, repo_id, parent_id, message, author_id, created_at, file_count, total_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.repoId, input.parentId, input.message, input.authorId, now, input.manifest.size, totalSize);

  const insertChange = db.prepare(
    `INSERT INTO snapshot_changes
       (snapshot_id, path, blob_hash, size, mime_type, updated_at,
        prev_blob_hash, prev_size, prev_mime_type, prev_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO repo_files (repo_id, path, blob_hash, size, mime_type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, path) DO UPDATE SET
       blob_hash = excluded.blob_hash, size = excluded.size,
       mime_type = excluded.mime_type, updated_at = excluded.updated_at`,
  );
  const deleteFile = db.prepare(`DELETE FROM repo_files WHERE repo_id = ? AND path = ?`);

  for (const entry of input.manifest.values()) {
    const prev = current.get(entry.path);
    if (
      prev &&
      prev.blob_hash === entry.blob_hash &&
      prev.size === entry.size &&
      prev.mime_type === entry.mime_type &&
      prev.updated_at === entry.updated_at
    ) {
      continue;
    }
    insertChange.run(
      id, entry.path, entry.blob_hash, entry.size, entry.mime_type, entry.updated_at,
      prev?.blob_hash ?? null, prev?.size ?? null, prev?.mime_type ?? null, prev?.updated_at ?? null,
    );
    upsertFile.run(input.repoId, entry.path, entry.blob_hash, entry.size, entry.mime_type, entry.updated_at);
  }
  for (const prev of current.values()) {
    if (input.manifest.has(prev.path)) continue;
    insertChange.run(
      id, prev.path, null, null, null, null,
      prev.blob_hash, prev.size, prev.mime_type, prev.updated_at,
    );
    deleteFile.run(input.repoId, prev.path);
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
      `SELECT file_count, total_size FROM snapshots WHERE id = ?`,
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
/**
 * 폴더 목록. `recursive` 면 하위 폴더까지의 파일을 모두 files 에 담고 dirs 는 비운다 — 내 폴더와
 * 견주기처럼 폴더 전체가 필요할 때 폴더마다 요청하지 않게.
 */
export function listTree(
  db: Db,
  snapshotId: string | null,
  dirPath: string,
  { recursive = false }: { recursive?: boolean } = {},
): TreeListing {
  const listing: TreeListing = { path: dirPath, snapshotId, dirs: [], files: [] };
  if (recursive) listing.recursive = true;
  if (!snapshotId) return listing;

  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const manifest = readManifest(db, snapshotId);
  const dirs = new Map<string, DirEntry>();

  for (const row of manifest.values()) {
    if (prefix && !row.path.startsWith(prefix)) continue;
    const rest = row.path.slice(prefix.length);
    const slash = recursive ? -1 : rest.indexOf('/');
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
  if (recursive) listing.files.sort((a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true }));
  else listing.files.sort(byName);
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
      `SELECT s.*, u.display_name
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
