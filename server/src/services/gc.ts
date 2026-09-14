/**
 * 참조되지 않는 blob 정리.
 *
 * blob 은 콘텐츠 주소라 여러 저장소·스냅샷이 같은 바이트를 공유한다. 그래서 파일을 지우거나
 * 저장소를 지워도 blob 자체는 그 자리에 남는다. 어디에서도 참조하지 않게 된 것만 골라 지운다.
 *
 * 참조하는 곳 — `repo_files`(지금 목록), `snapshot_changes`(저장소 이력, 앞뒤 값 모두),
 * `proposal_changes`(제안).
 * `repo_blobs` 는 "어느 저장소로 올라왔는지"를 적어 둔 것이라 참조로 치지 않는다.
 *
 * **갓 올라온 것은 건드리지 않는다.** 제안용으로 올린 blob 은 제안을 만들기 전까지 아무 데서도
 * 참조되지 않으므로, 올리는 도중에 지워지지 않도록 `minAgeMs` 만큼 유예를 둔다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.ts';

export interface GcResult {
  /** 지운 blob 개수. */
  removed: number;
  /** 회수한 바이트. */
  freedBytes: number;
  /** DB 에 기록이 없는데 디스크에 남아 있던 파일 수 (이전 GC 가 중간에 끊긴 흔적). */
  orphanFiles: number;
  /** 지우려다 실패한 것 (다음 번에 다시 시도한다). */
  failed: number;
  /** 오래 멈춰 치운 나눠 올리기 세션 수. */
  staleUploads: number;
}

interface BlobRow {
  hash: string;
  size: number;
}

/**
 * 한 번 정리한다. 서버가 돌고 있는 중에 불러도 된다 —
 * 지울 대상을 DB 에서 먼저 확정(트랜잭션)하고, 그 뒤에 파일을 지운다.
 */
export async function collectGarbage(ctx: AppContext, minAgeMs: number): Promise<GcResult> {
  const { db, blobs } = ctx;
  const cutoff = Date.now() - minAgeMs;
  const result: GcResult = { removed: 0, freedBytes: 0, orphanFiles: 0, failed: 0, staleUploads: 0 };
  result.staleUploads = await sweepUploadSessions(ctx, cutoff);

  const candidates = db
    .prepare<[number], BlobRow>(
      `SELECT b.hash, b.size
         FROM blobs b
        WHERE b.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM repo_files f WHERE f.blob_hash = b.hash)
          AND NOT EXISTS (SELECT 1 FROM snapshot_changes s WHERE s.blob_hash = b.hash)
          AND NOT EXISTS (SELECT 1 FROM snapshot_changes s WHERE s.prev_blob_hash = b.hash)
          AND NOT EXISTS (SELECT 1 FROM proposal_changes c WHERE c.blob_hash = b.hash)`,
    )
    .all(cutoff);

  if (candidates.length > 0) {
    // DB 를 먼저 정리한다. 파일을 먼저 지우면 그 사이 실패했을 때 "행은 있는데 파일이 없는"
    // 상태가 되어 다운로드가 깨진다. 반대 순서라면 최악이라도 고아 파일이 남고, 아래 2단계가 줍는다.
    const purge = db.transaction((rows: BlobRow[]) => {
      const dropRefs = db.prepare(`DELETE FROM repo_blobs WHERE hash = ?`);
      const dropBlob = db.prepare(`DELETE FROM blobs WHERE hash = ?`);
      for (const row of rows) {
        dropRefs.run(row.hash);
        dropBlob.run(row.hash);
      }
    });
    purge(candidates);

    for (const row of candidates) {
      try {
        await blobs.remove(row.hash);
        result.removed += 1;
        result.freedBytes += row.size;
      } catch {
        // 파일을 못 지웠으면 DB 기록은 이미 없으므로 아래 2단계가 다음 번에 줍는다.
        result.failed += 1;
      }
    }
  }

  result.orphanFiles = await sweepOrphanFiles(ctx, cutoff);
  return result;
}

/**
 * 오래 멈춘 나눠 올리기 세션을 치운다 — 앱이 올리다 말고 사라진 경우. 유예 시간(cutoff) 동안 조각이
 * 한 번도 오지 않은 세션과, 기록 없이 남은 세션 파일(저장소가 지워져 기록만 사라진 경우)을 지운다.
 */
async function sweepUploadSessions(ctx: AppContext, cutoff: number): Promise<number> {
  const stale = ctx.db
    .prepare<[number], { id: string }>(`SELECT id FROM upload_sessions WHERE updated_at < ?`)
    .all(cutoff);
  for (const { id } of stale) {
    ctx.db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(id);
    await ctx.blobs.removeSession(id);
  }
  const live = new Set(
    ctx.db.prepare<[], { id: string }>(`SELECT id FROM upload_sessions`).all().map((row) => row.id),
  );
  const tmp = path.join(ctx.config.blobDir, 'tmp');
  for (const entry of readDirSafe(tmp)) {
    if (!entry.isFile() || !entry.name.startsWith('session_')) continue;
    const id = entry.name.slice('session_'.length);
    if (live.has(id)) continue;
    try {
      if (fs.statSync(path.join(tmp, entry.name)).mtimeMs >= cutoff) continue;
      fs.rmSync(path.join(tmp, entry.name), { force: true });
    } catch {
      // 방금 완료돼 옮겨 갔을 수 있다.
    }
  }
  return stale.length;
}

/**
 * DB 에 없는 blob 파일을 지운다. GC 가 파일 삭제 도중 끊겼거나, 업로드가 저장까지 갔는데
 * 트랜잭션이 실패한 경우에 남는다. 임시 파일(`tmp/`)은 BlobStore 가 따로 정리한다.
 */
async function sweepOrphanFiles(ctx: AppContext, cutoff: number): Promise<number> {
  const root = ctx.config.blobDir;
  const known = ctx.db.prepare<[], { hash: string }>(`SELECT hash FROM blobs`).all();
  const keep = new Set(known.map((row) => row.hash));

  let removed = 0;
  for (const first of readDirSafe(root)) {
    if (first.name === 'tmp' || !first.isDirectory()) continue;
    for (const second of readDirSafe(path.join(root, first.name))) {
      if (!second.isDirectory()) continue;
      const dir = path.join(root, first.name, second.name);
      for (const entry of readDirSafe(dir)) {
        if (!entry.isFile() || keep.has(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        try {
          // 방금 만들어진 파일은 지금 업로드 중일 수 있다.
          if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
          fs.rmSync(filePath, { force: true });
          removed += 1;
        } catch {
          // 다른 요청이 방금 옮겨 갔을 수 있다 — 다음 번에 다시 본다.
        }
      }
    }
  }
  return removed;
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 주기적으로 GC 를 돈다. 멈추는 함수를 돌려준다.
 * 간격이나 유예 시간이 0 이면 아무것도 하지 않는다 (테스트·수동 운영).
 */
export function scheduleGc(
  ctx: AppContext,
  log: (result: GcResult) => void,
  onError: (err: unknown) => void,
): () => void {
  const { gcIntervalMs, gcMinAgeMs } = ctx.config;
  if (gcIntervalMs <= 0 || gcMinAgeMs <= 0) return () => {};

  const timer = setInterval(() => {
    collectGarbage(ctx, gcMinAgeMs).then(log, onError);
  }, gcIntervalMs);
  // GC 때문에 프로세스가 살아 있을 이유는 없다.
  timer.unref?.();
  return () => clearInterval(timer);
}
