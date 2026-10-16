import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { baseName, hasRole } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, notFound, tooLarge } from '../lib/errors.ts';
import { body, requireUser, requiredString } from '../lib/request.ts';
import { assertWritable } from '../services/mirror.ts';
import { requireAccess } from '../services/repos.ts';
import { toSession, uploadEngine, type SessionRow } from '../services/uploads.ts';

/**
 * 나눠 올리기 — 큰 파일을 조각으로 받고, 끊기면 받은 데까지에서 이어 간다.
 *
 *   POST   /repos/:repoId/uploads         {name, size, hash?}  → 세션, 또는 이미 있는 내용이면 바로 {blob}
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

const DAY_MS = 24 * 60 * 60 * 1000;

export async function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;
  const engine = uploadEngine(ctx);

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

  /** 내 세션을 찾고, 그 저장소에 아직 접근할 수 있는지 본다. 아니면 404. 받기 함 손님 세션은 여기서 다루지 않는다. */
  function requireSession(req: FastifyRequest): { row: SessionRow; role: ReturnType<typeof requireAccess>['role'] } {
    const user = requireUser(req);
    const { uploadId } = req.params as { uploadId: string };
    const row = db
      .prepare<[string, string], SessionRow>(
        `SELECT * FROM upload_sessions WHERE id = ? AND user_id = ? AND share_id IS NULL`,
      )
      .get(uploadId, user.id);
    if (!row) throw notFound('올리기 세션을 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'viewer');
    return { row, role };
  }

  app.post('/repos/:repoId/uploads', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { role } = requireAccess(db, repoId, user.id, 'viewer');
    assertWritable(db, repoId);
    const input = body(req);
    const name = baseName(requiredString(input, 'name', { max: 255, label: '파일 이름' }));
    const size = input.size;
    if (typeof size !== 'number') throw badRequest('파일 크기가 올바르지 않습니다.');
    const hash = input.hash ?? null;
    if (hash !== null && typeof hash !== 'string') throw badRequest('hash 는 sha256 16진수 64자여야 합니다.');

    const result = await engine.start({
      repoId,
      userId: user.id,
      name,
      size,
      hash,
      checkQuota: (bytes) => {
        if (!hasRole(role, 'editor') && stagedBytes(user.id) + bytes > config.maxStagingBytesPerDay) throw quotaError();
      },
    });
    // 이미 있는 내용이라 보낼 것이 없으면 200 에 blob, 새 세션이면 201.
    return reply.code(result.upload ? 201 : 200).send(result);
  });

  app.get('/uploads/:uploadId', async (req) => ({ upload: toSession(requireSession(req).row) }));

  app.put('/uploads/:uploadId', async (req) => {
    const { row } = requireSession(req);
    const offset = Number((req.query as { offset?: string }).offset);
    const upload = await engine.putChunk(row, offset, req.body as Readable | undefined, req.headers['content-type']);
    return { upload };
  });

  app.post('/uploads/:uploadId/complete', async (req, reply) => {
    const user = requireUser(req);
    const { row, role } = requireSession(req);
    const blob = await engine.complete(row, user.id, {
      onRecord: (stored, already) => {
        // 같은 내용을 같은 저장소에 다시 올린 것은 새로 저장되지 않으므로 세지 않는다.
        if (!already && !hasRole(role, 'editor') && stagedBytes(user.id) + stored.size > config.maxStagingBytesPerDay) {
          throw quotaError();
        }
      },
    });
    return reply.code(201).send({ blob });
  });

  app.delete('/uploads/:uploadId', async (req) => {
    const { row } = requireSession(req);
    await engine.cancel(row);
    return { ok: true };
  });
}

