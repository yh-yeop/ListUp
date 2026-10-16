import type { Readable } from 'node:stream';
import { UPLOAD_CHUNK_BYTES, type UploadSession, type UploadedBlob } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, tooLarge } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { DEFAULT_MIME, mimeForPath } from '../lib/mime.ts';
import { blobBelongsToRepo } from './proposals.ts';

/**
 * 나눠 올리기 엔진 — 로그인한 멤버의 올리기(routes/uploads.ts)와 받기 함 링크로 들어오는 손님의 올리기
 * (routes/shares.ts)가 함께 쓴다. 권한·한도는 부르는 쪽이 정하고, 여기서는 세션·조각·완료만 다룬다.
 */

export interface SessionRow {
  id: string;
  repo_id: string;
  user_id: string;
  name: string;
  size: number;
  received: number;
  /** 앱이 미리 계산해 보낸 sha256. 있으면 완료할 때 받은 내용과 견준다. */
  expected_hash: string | null;
  /** 받기 함으로 들어온 손님 세션이면 그 링크. */
  share_id: string | null;
}

export const HASH_RE = /^[0-9a-f]{64}$/;

/** 서버가 받는 조각의 최대 크기 — 앱이 쓰는 크기보다 넉넉히. */
const MAX_CHUNK_BYTES = UPLOAD_CHUNK_BYTES * 2;

export function toSession(row: SessionRow): UploadSession {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    size: row.size,
    received: row.received,
    chunkSize: UPLOAD_CHUNK_BYTES,
  };
}

export interface StartInput {
  repoId: string;
  userId: string;
  name: string;
  size: number;
  hash: string | null;
  shareId?: string | null;
  /** 새로 받아야 할 때(즉시 끝나지 않을 때)만 부른다 — 한도를 넘으면 던진다. */
  checkQuota?: (size: number) => void;
  /**
   * 이미 있는 내용이면 바로 끝낼지 (기본 참). 받기 함 손님에게는 끈다 — 그 저장소에 어떤 내용이 있는지를
   * 해시로 떠보는 데 쓰이지 않게. 손님이 보낸 해시는 손상 확인에만 쓴다.
   */
  allowInstant?: boolean;
}

export type StartResult = { upload: UploadSession; blob?: undefined } | { upload: null; blob: UploadedBlob };

export interface CompleteOptions {
  /**
   * 기록하는 트랜잭션 안에서 부른다. already 는 이 저장소에 이미 있던 내용인지 — 새로 디스크를 쓰지 않았으니
   * 한도에 세지 않는다. 던지면 아무것도 기록하지 않는다.
   */
  onRecord?: (blob: { hash: string; size: number }, already: boolean) => void;
  /** blob·repo_blobs 행이 생긴 뒤 같은 트랜잭션 안에서 — 그 해시를 참조하는 행을 넣을 때. */
  afterRecord?: (blob: { hash: string; size: number }) => void;
}

export function createUploadEngine(ctx: AppContext) {
  const { db, blobs, config } = ctx;
  /** 이 세션을 한 요청씩만 — 같은 세션에 조각이 동시에 오면 파일이 섞인다. */
  const busy = new Set<string>();

  /** 이 저장소에 쓸 수 있는, 디스크에 실제로 있는 blob 인지. */
  async function knownBlob(repoId: string, hash: string, size: number): Promise<boolean> {
    const row = db.prepare<[string], { size: number }>(`SELECT size FROM blobs WHERE hash = ?`).get(hash);
    if (!row || row.size !== size) return false;
    if (!blobBelongsToRepo(db, repoId, hash)) return false;
    return blobs.has(hash);
  }

  async function start(input: StartInput): Promise<StartResult> {
    const { repoId, userId, name, size, hash } = input;
    if (!Number.isSafeInteger(size) || size < 0) throw badRequest('파일 크기가 올바르지 않습니다.');
    if (size > config.maxUploadBytes) {
      throw tooLarge(`파일이 너무 큽니다. 최대 ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB.`);
    }
    if (hash !== null && !HASH_RE.test(hash)) throw badRequest('hash 는 sha256 16진수 64자여야 합니다.');

    // 이 저장소에 이미 있는 내용이면 보내지 않아도 된다 — 바로 blob 을 준다. 이 저장소에 올렸거나 이력에
    // 있던 것만이다(해시만 알아내 남의 저장소 파일을 가져오지 못하게).
    if (hash !== null && input.allowInstant !== false && (await knownBlob(repoId, hash, size))) {
      return { upload: null, blob: { hash, size, mimeType: mimeForPath(name), name } };
    }
    input.checkQuota?.(size);

    const now = Date.now();
    const row: SessionRow = {
      id: newId('up'),
      repo_id: repoId,
      user_id: userId,
      name,
      size,
      received: 0,
      expected_hash: hash,
      share_id: input.shareId ?? null,
    };
    await blobs.createSession(row.id);
    db.prepare(
      `INSERT INTO upload_sessions (id, repo_id, user_id, name, size, received, expected_hash, share_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(row.id, repoId, userId, name, size, row.expected_hash, row.share_id, now, now);
    return { upload: toSession(row) };
  }

  async function putChunk(
    row: SessionRow,
    offset: number,
    stream: Readable | undefined,
    contentType: string | undefined,
  ): Promise<UploadSession> {
    const drain = () => stream?.resume?.();
    if (!contentType?.startsWith('application/octet-stream') || !stream) {
      drain();
      throw badRequest('조각은 application/octet-stream 으로 보내야 합니다.');
    }
    if (!Number.isSafeInteger(offset) || offset !== row.received) {
      drain();
      // 끊긴 뒤 다시 보낼 때 어디서부터 보내야 하는지 알려준다.
      throw conflict('받은 위치와 다른 곳에서 보냈습니다.', { received: row.received });
    }
    const remaining = row.size - row.received;
    if (busy.has(row.id)) {
      drain();
      throw conflict('이 세션에 다른 조각을 받는 중입니다.', { received: row.received });
    }
    busy.add(row.id);
    try {
      const received = await blobs.appendChunk(row.id, offset, stream, Math.min(MAX_CHUNK_BYTES, remaining));
      if (received === offset && remaining > 0) throw badRequest('빈 조각입니다.');
      db.prepare(`UPDATE upload_sessions SET received = ?, updated_at = ? WHERE id = ?`).run(received, Date.now(), row.id);
      return toSession({ ...row, received });
    } finally {
      busy.delete(row.id);
    }
  }

  async function complete(row: SessionRow, uploaderId: string, options: CompleteOptions = {}): Promise<UploadedBlob> {
    if (row.received !== row.size) {
      throw conflict('아직 다 받지 못했습니다.', { received: row.received, size: row.size });
    }
    if (busy.has(row.id)) throw conflict('이 세션에 조각을 받는 중입니다.', { received: row.received });
    busy.add(row.id);
    try {
      const stored = await blobs.completeSession(row.id, row.size);
      const mimeType = row.name ? mimeForPath(row.name) : DEFAULT_MIME;
      const now = Date.now();
      const isNewBlob =
        db.prepare<[string], { ok: number }>(`SELECT 1 AS ok FROM blobs WHERE hash = ?`).get(stored.hash) === undefined;
      const record = db.transaction(() => {
        // 앱이 보낸 해시와 다르면 전송 중에 내용이 바뀐 것이다 — 기록하지 않는다.
        if (row.expected_hash && row.expected_hash !== stored.hash) {
          throw badRequest('받은 내용이 보낸 파일과 다릅니다. 전송 중에 손상됐을 수 있으니 다시 올려 주세요.', {
            expected: row.expected_hash,
            received: stored.hash,
          });
        }
        const already = db
          .prepare<[string, string], { ok: number }>(`SELECT 1 AS ok FROM repo_blobs WHERE repo_id = ? AND hash = ?`)
          .get(row.repo_id, stored.hash);
        // 한도 검사는 이 올리기를 기록하기 전에(자기 자신을 세지 않게). 던지면 전부 되돌린다.
        options.onRecord?.(stored, already !== undefined);
        db.prepare(
          `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
        ).run(stored.hash, stored.size, mimeType, now);
        db.prepare(
          `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
        ).run(row.repo_id, stored.hash, uploaderId, now);
        options.afterRecord?.(stored);
        db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(row.id);
      });
      try {
        record();
      } catch (err) {
        // 세션 파일은 이미 blob 자리로 옮겨졌으니 세션도 끝낸다. 이 요청이 처음 만든 blob 이면 지운다
        // (DB 에 기록되지 않았으므로 두면 디스크만 차지한다).
        db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(row.id);
        if (isNewBlob) await blobs.remove(stored.hash);
        throw err;
      }
      return { hash: stored.hash, size: stored.size, mimeType, name: row.name };
    } finally {
      busy.delete(row.id);
    }
  }

  async function cancel(row: SessionRow): Promise<void> {
    if (busy.has(row.id)) throw conflict('이 세션에 조각을 받는 중입니다.', { received: row.received });
    db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(row.id);
    await blobs.removeSession(row.id);
  }

  return { knownBlob, start, putChunk, complete, cancel };
}

export type UploadEngine = ReturnType<typeof createUploadEngine>;

const engines = new WeakMap<AppContext, UploadEngine>();

/** 서버 하나에 엔진 하나 — 같은 세션에 조각이 겹쳐 오지 않게 막는 표(busy)를 라우트끼리 나눈다. */
export function uploadEngine(ctx: AppContext): UploadEngine {
  let engine = engines.get(ctx);
  if (!engine) {
    engine = createUploadEngine(ctx);
    engines.set(ctx, engine);
  }
  return engine;
}
