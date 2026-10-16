import { Readable } from 'node:stream';
import { normalizePath, type MirrorManifest, type RepoMirror } from '@listup/shared';
import type { AppContext } from '../context.ts';
import type { Db } from '../db/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { mimeForPath } from '../lib/mime.ts';
import { isMirrorSyncing, markMirrorSyncing } from './repos.ts';
import { readManifest, writeSnapshot, type EntryRow } from './snapshots.ts';

/**
 * 서버 간 따라가기(미러) — 다른 ListUp 서버의 저장소를 이 서버에 읽기 전용 사본으로 두고, 바뀐 것만 가져온다.
 *
 * 원본 서버의 소유자가 "따라가기 키"(shares.kind = mirror)를 만들어 주면, 이 서버의 누군가가 그 링크
 * (`https://원본/s/<키>`)로 미러 저장소를 만든다. 이 서버가 원본의 지금 모습(경로·해시 목록)을 받아, 아직 없는
 * 내용(해시)만 내려받고 스냅샷 하나로 반영한다. 내용 주소라 이미 있는 것은 다시 받지 않는다.
 *
 * - 받은 내용은 해시를 다시 계산해 원본이 말한 해시와 맞을 때만 쓴다.
 * - 원본 서버가 꺼져 있어도 사본은 그대로 볼 수 있다 — 백업을 겸한다.
 * - 미러 저장소에는 파일을 올리거나 제안할 수 없다(원본에서 하고 따라온다). 따라가기를 그만두면 보통 저장소가 된다.
 *
 * 이 서버가 남이 준 주소로 요청을 보내므로, 실패 이유를 자세히 돌려주지 않는다(내부망을 떠보는 데 쓰이지 않게).
 */

const MANIFEST_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

interface MirrorRow {
  repo_id: string;
  source_url: string;
  source_token: string;
  source_head: string | null;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
}


/** `https://서버/s/<키>` 를 서버 주소와 키로. 다른 모양이면 null. */
export function parseMirrorLink(link: string): { sourceUrl: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const match = url.pathname.match(/^(.*)\/s\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (!match || url.search || url.username || url.password) return null;
  return { sourceUrl: `${url.origin}${match[1]}`, token: match[2] };
}

const UNREACHABLE = '원본 서버에 닿지 못했거나 따라가기 키가 올바르지 않습니다.';

/** 원본의 지금 모습. 형식이 다르면 던진다. */
export async function fetchMirrorManifest(sourceUrl: string, token: string): Promise<MirrorManifest> {
  let response: Response;
  try {
    response = await fetch(`${sourceUrl}/api/s/${token}/mirror`, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw badRequest(UNREACHABLE);
  }
  if (!response.ok) throw badRequest(UNREACHABLE);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_MANIFEST_BYTES) throw badRequest('원본 저장소가 너무 큽니다.');
  let parsed: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('too large');
    parsed = JSON.parse(text);
  } catch {
    throw badRequest(UNREACHABLE);
  }
  const manifest = parsed as Partial<MirrorManifest>;
  if (!manifest?.repo || typeof manifest.repo.name !== 'string' || !Array.isArray(manifest.files)) {
    throw badRequest(UNREACHABLE);
  }
  return manifest as MirrorManifest;
}

export function getMirror(db: Db, repoId: string): MirrorRow | undefined {
  return db.prepare<[string], MirrorRow>(`SELECT * FROM mirrors WHERE repo_id = ?`).get(repoId);
}

export function toRepoMirror(row: MirrorRow): RepoMirror {
  return {
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    syncing: isMirrorSyncing(row.repo_id),
  };
}

/** 미러 저장소면 409 — 파일을 바꾸는 요청 앞에서 부른다. */
export function assertWritable(db: Db, repoId: string): void {
  if (getMirror(db, repoId)) {
    throw conflict('다른 서버를 따라가는 저장소라 여기서는 바꿀 수 없습니다. 원본 서버에서 바꾸면 따라옵니다.');
  }
}

export interface SyncResult {
  changed: boolean;
  /** 새로 받은 내용 수와 크기. */
  fetched: number;
  fetchedBytes: number;
}

/**
 * 원본에서 바뀐 것을 가져와 반영한다. 실패하면 last_error 에 남기고 던진다.
 */
export async function syncMirror(ctx: AppContext, repoId: string): Promise<SyncResult> {
  const { db, blobs, config } = ctx;
  const mirror = getMirror(db, repoId);
  if (!mirror) throw badRequest('따라가는 저장소가 아닙니다.');
  // 같은 저장소를 두 번 동시에 가져오지 않는다.
  if (isMirrorSyncing(repoId)) throw conflict('지금 가져오는 중입니다.');
  markMirrorSyncing(repoId, true);
  try {
    const manifest = await fetchMirrorManifest(mirror.source_url, mirror.source_token);
    const now = Date.now();
    if (manifest.head !== null && manifest.head === mirror.source_head) {
      db.prepare(`UPDATE mirrors SET last_synced_at = ?, last_error = NULL WHERE repo_id = ?`).run(now, repoId);
      return { changed: false, fetched: 0, fetchedBytes: 0 };
    }

    // 원본의 경로를 이 서버의 규칙으로 다시 검사한다.
    const next = new Map<string, EntryRow>();
    let total = 0;
    for (const file of manifest.files) {
      const path = typeof file.path === 'string' ? normalizePath(file.path) : null;
      if (!path || typeof file.blobHash !== 'string' || !HASH_RE.test(file.blobHash)) continue;
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > config.maxUploadBytes) continue;
      total += file.size;
      next.set(path, {
        path,
        blob_hash: file.blobHash,
        size: file.size,
        mime_type: mimeForPath(path),
        updated_at: Number.isSafeInteger(file.updatedAt) ? file.updatedAt : now,
      });
    }
    if (total > config.maxRepoBytes) throw badRequest('원본 저장소가 이 서버의 저장소 용량 한도를 넘습니다.');

    const owner = db.prepare<[string], { owner_id: string }>(`SELECT owner_id FROM repos WHERE id = ?`).get(repoId)!.owner_id;
    const result: SyncResult = { changed: false, fetched: 0, fetchedBytes: 0 };
    const known = db.prepare<[string], { size: number }>(`SELECT size FROM blobs WHERE hash = ?`);
    const fetchedHashes = new Set<string>();
    for (const entry of next.values()) {
      if (fetchedHashes.has(entry.blob_hash)) continue;
      if (known.get(entry.blob_hash) && (await blobs.has(entry.blob_hash))) continue;
      let response: Response;
      try {
        response = await fetch(`${mirror.source_url}/api/s/${mirror.source_token}/mirror/blobs/${entry.blob_hash}`, {
          redirect: 'error',
        });
      } catch {
        throw badRequest(UNREACHABLE);
      }
      if (!response.ok || !response.body) throw badRequest(`원본에서 내용을 받지 못했습니다: ${entry.path}`);
      const stored = await blobs.writeStream(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        config.maxUploadBytes,
      );
      if (stored.hash !== entry.blob_hash || stored.size !== entry.size) {
        // 엉뚱한 내용이 이미 이 서버에 있던 것과 같다면 그 파일은 지우지 않는다.
        if (!known.get(stored.hash)) await blobs.remove(stored.hash);
        throw badRequest(`원본에서 받은 내용이 목록과 다릅니다: ${entry.path}`);
      }
      db.prepare(
        `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
      ).run(stored.hash, stored.size, entry.mime_type, Date.now());
      fetchedHashes.add(stored.hash);
      result.fetched += 1;
      result.fetchedBytes += stored.size;
    }

    db.transaction(() => {
      const repo = db.prepare<[string], { head_snapshot_id: string | null }>(`SELECT head_snapshot_id FROM repos WHERE id = ?`).get(repoId)!;
      const current = readManifest(db, repo.head_snapshot_id);
      const record = db.prepare(
        `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
      );
      for (const entry of next.values()) record.run(repoId, entry.blob_hash, owner, Date.now());
      const same =
        current.size === next.size && [...next.values()].every((entry) => current.get(entry.path)?.blob_hash === entry.blob_hash);
      if (!same) {
        writeSnapshot(db, {
          repoId,
          parentId: repo.head_snapshot_id,
          authorId: owner,
          message: `따라가기: 원본에서 가져옴 (${next.size}개 파일)`,
          manifest: next,
        });
        result.changed = true;
      }
      db.prepare(`UPDATE mirrors SET source_head = ?, last_synced_at = ?, last_error = NULL WHERE repo_id = ?`).run(
        manifest.head,
        Date.now(),
        repoId,
      );
    })();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE mirrors SET last_error = ? WHERE repo_id = ?`).run(message.slice(0, 300), repoId);
    throw err;
  } finally {
    markMirrorSyncing(repoId, false);
  }
}

/** 모든 미러를 차례로 가져온다(하나가 실패해도 다음 것은 한다). */
export async function syncAllMirrors(ctx: AppContext): Promise<{ synced: number; failed: number }> {
  const ids = ctx.db.prepare<[], { repo_id: string }>(`SELECT repo_id FROM mirrors`).all();
  let synced = 0;
  let failed = 0;
  for (const { repo_id } of ids) {
    try {
      await syncMirror(ctx, repo_id);
      synced += 1;
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
}

/** 주기적으로 모든 미러를 가져온다. 멈추는 함수를 돌려준다. */
export function scheduleMirrors(ctx: AppContext, onError: (err: unknown) => void): () => void {
  if (ctx.config.mirrorIntervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    syncAllMirrors(ctx).catch(onError);
  }, ctx.config.mirrorIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
