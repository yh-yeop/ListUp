import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UPLOAD_CHUNK_BYTES, baseName, hasRole, type UploadSession } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, notFound, tooLarge } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { DEFAULT_MIME, mimeForPath } from '../lib/mime.ts';
import { body, requireUser, requiredString } from '../lib/request.ts';
import { requireAccess } from '../services/repos.ts';

/**
 * 나눠 올리기 — 큰 파일을 조각으로 받고, 끊기면 받은 데까지에서 이어 간다.
 *
 *   POST   /repos/:repoId/uploads         {name, size}  → 세션
 *   GET    /uploads/:uploadId                            → 세션 (끊긴 뒤 어디까지 받았는지)
 *   PUT    /uploads/:uploadId?offset=N    바이트          → 세션   offset 이 받은 길이와 다르면 409
 *   POST   /uploads/:uploadId/complete                   → {blob}
 *   DELETE /uploads/:uploadId                            → 취소
 *
 * 완료한 blob 은 여러 파일 커밋(POST /repos/:id/files/commit)이나 변경 제안에 hash 로 담는다.
 * 한 요청 본문이 프록시 한도(Cloudflare 100MB)를 넘지 않으므로, 한 파일 크기는 LISTUP_MAX_UPLOAD_MB 만 따른다.
 *
 * 편집 권한이 없는 사람(열람자)은 제안용으로만 올리므로, 반영되지 않는 업로드로 디스크를 채우지 못하게
 * 하루 업로드 총량(LISTUP_MAX_STAGING_MB_PER_DAY)을 본다. 편집자는 어차피 직접 커밋할 수 있어 세지 않는다.
 */

interface SessionRow {
  id: string;
  repo_id: string;
  user_id: string;
  name: string;
  size: number;
  received: number;
}

/** 서버가 받는 조각의 최대 크기 — 앱이 쓰는 크기보다 넉넉히. */
const MAX_CHUNK_BYTES = UPLOAD_CHUNK_BYTES * 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function toSession(row: SessionRow): UploadSession {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    size: row.size,
    received: row.received,
    chunkSize: UPLOAD_CHUNK_BYTES,
  };
}

export async function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, blobs, config } = ctx;

  // 조각은 원시 바이트로 받는다 — 스트림을 그대로 넘겨 라우트에서 크기를 센다.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  /** 하루 동안 이 사용자가 올린(스테이징) 총량 — 제안용 업로드 한도. */
  const stagedBytes = (userId: string) =>
    db
      .prepare<[string, number], { total: number }>(
        `SELECT COALESCE(SUM(b.size), 0) AS total
           FROM repo_blobs rb JOIN blobs b ON b.hash = rb.hash
          WHERE rb.uploaded_by = ? AND rb.created_at > ?`,
      )
      .get(userId, Date.now() - DAY_MS)!.total;
  const quotaError = () =>
    tooLarge(`하루 업로드 한도(${Math.floor(config.maxStagingBytesPerDay / 1024 / 1024)}MB)를 넘었습니다.`);

  /** 내 세션을 찾고, 그 저장소에 아직 접근할 수 있는지 본다. 아니면 404. */
  function requireSession(req: FastifyRequest): { row: SessionRow; role: ReturnType<typeof requireAccess>['role'] } {
    const user = requireUser(req);
    const { uploadId } = req.params as { uploadId: string };
    const row = db
      .prepare<[string, string], SessionRow>(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?`)
      .get(uploadId, user.id);
    if (!row) throw notFound('올리기 세션을 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'viewer');
    return { row, role };
  }

  app.post('/repos/:repoId/uploads', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { role } = requireAccess(db, repoId, user.id, 'viewer');
    const input = body(req);
    const name = baseName(requiredString(input, 'name', { max: 255, label: '파일 이름' }));
    const size = input.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw badRequest('파일 크기가 올바르지 않습니다.');
    }
    if (size > config.maxUploadBytes) {
      throw tooLarge(`파일이 너무 큽니다. 최대 ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB.`);
    }
    if (!hasRole(role, 'editor') && stagedBytes(user.id) + size > config.maxStagingBytesPerDay) {
      throw quotaError();
    }

    const now = Date.now();
    const row: SessionRow = { id: newId('up'), repo_id: repoId, user_id: user.id, name, size, received: 0 };
    await blobs.createSession(row.id);
    db.prepare(
      `INSERT INTO upload_sessions (id, repo_id, user_id, name, size, received, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(row.id, repoId, user.id, name, size, now, now);
    return reply.code(201).send({ upload: toSession(row) });
  });

  app.get('/uploads/:uploadId', async (req) => ({ upload: toSession(requireSession(req).row) }));

  /** 이 세션을 한 요청씩만 — 같은 세션에 조각이 동시에 오면 파일이 섞인다. */
  const busy = new Set<string>();

  app.put('/uploads/:uploadId', async (req) => {
    const { row } = requireSession(req);
    const stream = req.body as NodeJS.ReadableStream | undefined;
    const drain = () => (stream as { resume?: () => void } | undefined)?.resume?.();
    if (!req.headers['content-type']?.startsWith('application/octet-stream') || !stream) {
      drain();
      throw badRequest('조각은 application/octet-stream 으로 보내야 합니다.');
    }
    const offset = Number((req.query as { offset?: string }).offset);
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
      const received = await blobs.appendChunk(
        row.id,
        offset,
        stream as unknown as import('node:stream').Readable,
        Math.min(MAX_CHUNK_BYTES, remaining),
      );
      if (received === offset && remaining > 0) throw badRequest('빈 조각입니다.');
      db.prepare(`UPDATE upload_sessions SET received = ?, updated_at = ? WHERE id = ?`).run(received, Date.now(), row.id);
      return { upload: toSession({ ...row, received }) };
    } finally {
      busy.delete(row.id);
    }
  });

  app.post('/uploads/:uploadId/complete', async (req, reply) => {
    const user = requireUser(req);
    const { row, role } = requireSession(req);
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
        const already = db
          .prepare<[string, string], { ok: number }>(`SELECT 1 AS ok FROM repo_blobs WHERE repo_id = ? AND hash = ?`)
          .get(row.repo_id, stored.hash);
        // 같은 내용을 같은 저장소에 다시 올린 것은 새로 저장되지 않으므로 세지 않는다.
        if (!already && !hasRole(role, 'editor') && stagedBytes(user.id) + stored.size > config.maxStagingBytesPerDay) {
          throw quotaError();
        }
        db.prepare(
          `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
        ).run(stored.hash, stored.size, mimeType, now);
        db.prepare(
          `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
        ).run(row.repo_id, stored.hash, user.id, now);
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
      return reply.code(201).send({
        blob: { hash: stored.hash, size: stored.size, mimeType, name: row.name },
      });
    } finally {
      busy.delete(row.id);
    }
  });

  app.delete('/uploads/:uploadId', async (req) => {
    const { row } = requireSession(req);
    if (busy.has(row.id)) throw conflict('이 세션에 조각을 받는 중입니다.', { received: row.received });
    db.prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(row.id);
    await blobs.removeSession(row.id);
    return { ok: true };
  });
}
