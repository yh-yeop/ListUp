import type { HistoryKeepOlder } from '@listup/shared';
import type { Db } from '../db/index.ts';

/**
 * 변경 이력 보존 — 오래된 스냅샷을 솎아 디스크를 돌려받는다.
 *
 * 스냅샷은 바뀐 경로만 앞뒤 값과 함께 적고(snapshot_changes), 과거 시점은 head 에서 뒤로 되돌려 만든다.
 * 그래서 중간의 스냅샷 S 를 그냥 지우면 그보다 오래된 시점을 만들 수 없다. 지울 때는 S 의 변경을 바로 다음
 * 스냅샷 C 에 **합친다**: C 는 "S 앞의 상태 → C 뒤의 상태"를 한 번에 적게 되고, 남은 시점들은 그대로 만들어진다.
 * S 만 거쳐 간 중간 내용은 어디서도 참조하지 않게 되어 blob GC 가 지운다.
 *
 * 남기는 것: head, 보존 기간(days) 안의 모든 스냅샷, 열린 제안의 기준 시점(충돌 판단에 쓴다), 그리고
 * keepOlder 에 따라 오래된 것 중 하루·한 주·한 달마다 마지막 하나.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  days: number;
  keepOlder: HistoryKeepOlder;
  now?: number;
}

export interface PruneResult {
  /** 지운 스냅샷 수. */
  removed: number;
  /** 하나라도 지운 저장소 수. */
  repos: number;
}

interface ChangeRow {
  snapshot_id: string;
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

interface SnapshotNode {
  id: string;
  parent_id: string | null;
  created_at: number;
}

/** 오래된 스냅샷을 묶는 단위 — 같은 열쇠끼리는 마지막 하나만 남긴다. 서버 PC 의 시간대를 따른다. */
function periodKey(at: number, keep: HistoryKeepOlder): string | null {
  const d = new Date(at);
  switch (keep) {
    case 'none':
      return null;
    case 'daily':
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    case 'monthly':
      return `${d.getFullYear()}-${d.getMonth()}`;
    case 'weekly': {
      // 월요일에 시작하는 주. 그 주 월요일 자정을 열쇠로 쓴다.
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return String(monday.getTime());
    }
  }
}

/** head 에서 부모를 따라간 줄을 오래된 것부터. */
function chainOf(db: Db, headId: string): SnapshotNode[] {
  const byId = new Map(
    db
      .prepare<[string], SnapshotNode>(
        `SELECT id, parent_id, created_at FROM snapshots WHERE repo_id = (SELECT repo_id FROM snapshots WHERE id = ?)`,
      )
      .all(headId)
      .map((row) => [row.id, row]),
  );
  const chain: SnapshotNode[] = [];
  for (let node = byId.get(headId); node; node = node.parent_id ? byId.get(node.parent_id) : undefined) {
    chain.push(node);
  }
  return chain.reverse();
}

const sameEntry = (row: ChangeRow) =>
  row.blob_hash === row.prev_blob_hash &&
  row.size === row.prev_size &&
  row.mime_type === row.prev_mime_type &&
  row.updated_at === row.prev_updated_at;

/**
 * 스냅샷 S 를 지우고 그 변경을 자식 C 에 합친다. 트랜잭션 안에서 부른다.
 * C 의 변경 중 S 가 건드린 경로는 "앞의 값"을 S 의 앞의 값으로 바꾸고, C 가 건드리지 않은 경로는 S 의 변경을 그대로
 * C 로 옮긴다. 합친 뒤 앞뒤가 같아진 경로(S 가 더하고 C 가 지움 등)는 변경이 아니므로 뺀다.
 */
export function squashIntoChild(db: Db, snapshot: SnapshotNode, child: SnapshotNode): void {
  const changesOf = db.prepare<[string], ChangeRow>(`SELECT * FROM snapshot_changes WHERE snapshot_id = ?`);
  const childChanges = new Map(changesOf.all(child.id).map((row) => [row.path, row]));
  const update = db.prepare(
    `UPDATE snapshot_changes SET prev_blob_hash = ?, prev_size = ?, prev_mime_type = ?, prev_updated_at = ?
      WHERE snapshot_id = ? AND path = ?`,
  );
  const remove = db.prepare(`DELETE FROM snapshot_changes WHERE snapshot_id = ? AND path = ?`);
  const insert = db.prepare(
    `INSERT INTO snapshot_changes
       (snapshot_id, path, blob_hash, size, mime_type, updated_at, prev_blob_hash, prev_size, prev_mime_type, prev_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const own of changesOf.all(snapshot.id)) {
    const later = childChanges.get(own.path);
    if (later) {
      const merged = {
        ...later,
        prev_blob_hash: own.prev_blob_hash,
        prev_size: own.prev_size,
        prev_mime_type: own.prev_mime_type,
        prev_updated_at: own.prev_updated_at,
      };
      if (sameEntry(merged)) remove.run(child.id, own.path);
      else update.run(own.prev_blob_hash, own.prev_size, own.prev_mime_type, own.prev_updated_at, child.id, own.path);
    } else {
      insert.run(
        child.id, own.path, own.blob_hash, own.size, own.mime_type, own.updated_at,
        own.prev_blob_hash, own.prev_size, own.prev_mime_type, own.prev_updated_at,
      );
    }
  }

  db.prepare(`UPDATE snapshots SET parent_id = ? WHERE id = ?`).run(snapshot.parent_id, child.id);
  // 닫히거나 반영된 제안이 가리키던 시점은 비운다(열린 제안의 기준은 처음부터 지우지 않는다).
  db.prepare(`UPDATE proposals SET base_snapshot_id = NULL WHERE base_snapshot_id = ?`).run(snapshot.id);
  db.prepare(`UPDATE proposals SET merged_snapshot_id = NULL WHERE merged_snapshot_id = ?`).run(snapshot.id);
  db.prepare(`DELETE FROM snapshot_changes WHERE snapshot_id = ?`).run(snapshot.id);
  db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(snapshot.id);
}

/** 저장소 하나의 이력을 솎는다. 지운 스냅샷 수를 돌려준다. */
export function pruneRepoHistory(db: Db, repoId: string, options: PruneOptions): number {
  if (options.days <= 0) return 0;
  const now = options.now ?? Date.now();
  const cutoff = now - options.days * DAY_MS;

  return db.transaction(() => {
    const head = db
      .prepare<[string], { head_snapshot_id: string | null }>(`SELECT head_snapshot_id FROM repos WHERE id = ?`)
      .get(repoId)?.head_snapshot_id;
    if (!head) return 0;
    const chain = chainOf(db, head);

    const keep = new Set<string>([head]);
    for (const row of db
      .prepare<[string], { base_snapshot_id: string }>(
        `SELECT base_snapshot_id FROM proposals WHERE repo_id = ? AND status = 'open' AND base_snapshot_id IS NOT NULL`,
      )
      .all(repoId)) {
      keep.add(row.base_snapshot_id);
    }
    // 오래된 것 중 단위마다 마지막 것. chain 이 오래된 순이므로 뒤의 것이 덮어쓴다.
    const lastOfPeriod = new Map<string, string>();
    for (const node of chain) {
      if (node.created_at >= cutoff) {
        keep.add(node.id);
        continue;
      }
      const key = periodKey(node.created_at, options.keepOlder);
      if (key !== null) lastOfPeriod.set(key, node.id);
    }
    for (const id of lastOfPeriod.values()) keep.add(id);

    let removed = 0;
    // 오래된 것부터 지운다 — 지운 것의 변경은 다음 스냅샷에 실려 가며 쌓인다.
    for (let index = 0; index < chain.length - 1; index += 1) {
      const node = chain[index];
      if (keep.has(node.id)) continue;
      const child = chain[index + 1];
      squashIntoChild(db, node, child);
      // 자식의 부모가 바뀌었으니 줄에서도 이어 준다.
      chain[index + 1] = { ...child, parent_id: node.parent_id };
      removed += 1;
    }
    return removed;
  })();
}

/** 모든 저장소의 이력을 솎는다. */
export function pruneHistory(db: Db, options: PruneOptions): PruneResult {
  const result: PruneResult = { removed: 0, repos: 0 };
  if (options.days <= 0) return result;
  for (const { id } of db.prepare<[], { id: string }>(`SELECT id FROM repos`).all()) {
    const removed = pruneRepoHistory(db, id, options);
    if (removed > 0) {
      result.removed += removed;
      result.repos += 1;
    }
  }
  return result;
}
