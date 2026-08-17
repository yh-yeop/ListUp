import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_FILES_PER_REPO,
  MAX_NAME_LENGTH,
  baseName,
  normalizeDirPath,
  normalizePath,
} from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { DEFAULT_MIME, isInlineSafe, mimeForPath } from '../lib/mime.ts';
import { body, queryString, requireUser, requiredString } from '../lib/request.ts';
import { requireAccess } from '../services/repos.ts';
import {
  listTree,
  readManifest,
  snapshotBelongsTo,
  writeSnapshot,
  type EntryRow,
} from '../services/snapshots.ts';

/** 파일명에 따옴표/개행이 들어가도 안전한 Content-Disposition 을 만든다. */
export function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 요청에서 경로 파라미터를 읽고 정규화한다. */
function requirePathParam(req: FastifyRequest, key = 'path'): string {
  const raw = queryString(req, key);
  if (raw === undefined) throw badRequest('경로가 필요합니다.');
  const normalized = normalizePath(raw);
  if (!normalized) throw badRequest('경로가 올바르지 않습니다.');
  return normalized;
}

export async function registerFileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, blobs, config } = ctx;

  /** 디렉터리 목록. `snapshot` 을 주면 과거 시점을 본다. */
  app.get('/repos/:repoId/files', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'viewer');

    const dirPath = normalizeDirPath(queryString(req, 'path'));
    if (dirPath === null) throw badRequest('경로가 올바르지 않습니다.');

    const requested = queryString(req, 'snapshot');
    let snapshotId = repo.head_snapshot_id;
    if (requested) {
      if (!snapshotBelongsTo(db, requested, repoId)) throw notFound('스냅샷을 찾을 수 없습니다.');
      snapshotId = requested;
    }

    return { tree: listTree(db, snapshotId, dirPath) };
  });

  /**
   * 파일 업로드 = 직접 커밋. 경로는 쿼리스트링으로 받아서
   * multipart 파트 순서에 의존하지 않게 한다.
   */
  app.post('/repos/:repoId/files', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'editor');

    const part = await req.file();
    if (!part) throw badRequest('업로드할 파일이 없습니다.');

    // 경로를 안 주면 업로드된 파일명을 그대로 쓴다.
    const rawPath = queryString(req, 'path') ?? part.filename ?? '';
    const filePath = normalizePath(rawPath);
    if (!filePath) {
      // 스트림을 소비하지 않으면 연결이 멈춘다.
      part.file.resume();
      throw badRequest('저장할 경로가 올바르지 않습니다.');
    }

    const stored = await blobs.writeStream(part.file, config.maxUploadBytes);
    const now = Date.now();
    const mimeType = mimeForPath(filePath);

    const snapshotId = db.transaction(() => {
      db.prepare(
        `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      ).run(stored.hash, stored.size, mimeType, now);

      const manifest = readManifest(db, repo.head_snapshot_id);
      const existing = manifest.get(filePath);
      if (!existing && manifest.size >= MAX_FILES_PER_REPO) {
        throw conflict(`저장소당 파일은 최대 ${MAX_FILES_PER_REPO}개입니다.`);
      }
      if (existing && existing.blob_hash === stored.hash) {
        // 내용이 같으면 새 스냅샷을 만들지 않는다.
        return repo.head_snapshot_id;
      }

      manifest.set(filePath, {
        path: filePath,
        blob_hash: stored.hash,
        size: stored.size,
        mime_type: mimeType,
        updated_at: now,
      });

      return writeSnapshot(db, {
        repoId,
        parentId: repo.head_snapshot_id,
        authorId: user.id,
        message: `${existing ? '수정' : '추가'}: ${filePath}`,
        manifest,
        now,
      });
    })();

    return reply.code(201).send({
      file: {
        path: filePath,
        name: baseName(filePath),
        blobHash: stored.hash,
        size: stored.size,
        mimeType,
        updatedAt: now,
      },
      snapshotId,
      unchanged: snapshotId === repo.head_snapshot_id,
    });
  });

  /**
   * 파일 또는 폴더 삭제. 폴더면 아래 전체가 지워진다.
   * blob 자체는 다른 스냅샷/저장소가 참조할 수 있으므로 남겨둔다.
   */
  app.delete('/repos/:repoId/files', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'editor');
    const target = requirePathParam(req);

    const result = db.transaction(() => {
      const manifest = readManifest(db, repo.head_snapshot_id);
      const removed: string[] = [];
      const prefix = `${target}/`;
      for (const path of [...manifest.keys()]) {
        if (path === target || path.startsWith(prefix)) {
          manifest.delete(path);
          removed.push(path);
        }
      }
      if (removed.length === 0) throw notFound('해당 경로에 파일이 없습니다.');

      const message =
        removed.length === 1 ? `삭제: ${removed[0]}` : `삭제: ${target}/ (${removed.length}개)`;
      const snapshotId = writeSnapshot(db, {
        repoId,
        parentId: repo.head_snapshot_id,
        authorId: user.id,
        message,
        manifest,
      });
      return { removed, snapshotId };
    })();

    return result;
  });

  /** 파일/폴더 이름 변경·이동. */
  app.post('/repos/:repoId/files/move', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'editor');
    const input = body(req);

    const fromRaw = requiredString(input, 'from', { max: 512, label: '원본 경로' });
    const toRaw = requiredString(input, 'to', { max: 512, label: '새 경로' });
    const from = normalizePath(fromRaw);
    const to = normalizePath(toRaw);
    if (!from || !to) throw badRequest('경로가 올바르지 않습니다.');
    if (from === to) throw badRequest('경로가 같습니다.');
    if (to.startsWith(`${from}/`)) throw badRequest('폴더를 자기 자신 아래로 옮길 수 없습니다.');

    const result = db.transaction(() => {
      const manifest = readManifest(db, repo.head_snapshot_id);
      const now = Date.now();
      const prefix = `${from}/`;
      const moves: { from: string; to: string }[] = [];

      for (const path of manifest.keys()) {
        if (path === from) moves.push({ from: path, to });
        else if (path.startsWith(prefix)) moves.push({ from: path, to: `${to}/${path.slice(prefix.length)}` });
      }
      if (moves.length === 0) throw notFound('해당 경로에 파일이 없습니다.');

      for (const move of moves) {
        if (manifest.has(move.to)) throw conflict(`이미 존재하는 경로입니다: ${move.to}`);
      }

      for (const move of moves) {
        const entry = manifest.get(move.from)!;
        manifest.delete(move.from);
        manifest.set(move.to, {
          ...entry,
          path: move.to,
          mime_type: mimeForPath(move.to),
          updated_at: now,
        });
      }

      const snapshotId = writeSnapshot(db, {
        repoId,
        parentId: repo.head_snapshot_id,
        authorId: user.id,
        message: `이동: ${from} → ${to}`,
        manifest,
        now,
      });
      return { moved: moves.length, snapshotId };
    })();

    return result;
  });

  /** 파일 내려받기. `snapshot` 으로 과거 버전도 받을 수 있다. */
  app.get('/repos/:repoId/raw', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'viewer');
    const filePath = requirePathParam(req);

    const requested = queryString(req, 'snapshot');
    let snapshotId = repo.head_snapshot_id;
    if (requested) {
      if (!snapshotBelongsTo(db, requested, repoId)) throw notFound('스냅샷을 찾을 수 없습니다.');
      snapshotId = requested;
    }
    if (!snapshotId) throw notFound('파일을 찾을 수 없습니다.');

    const entry = db
      .prepare<[string, string], EntryRow>(
        `SELECT path, blob_hash, size, mime_type, updated_at
           FROM snapshot_entries WHERE snapshot_id = ? AND path = ?`,
      )
      .get(snapshotId, filePath);
    if (!entry) throw notFound('파일을 찾을 수 없습니다.');

    return sendBlob(reply, ctx, entry.blob_hash, {
      fileName: baseName(entry.path),
      mimeType: entry.mime_type,
      size: entry.size,
      inline: queryString(req, 'inline') === '1',
    });
  });

  /**
   * 변경 제안용 blob 업로드. 아직 어느 저장소에도 반영되지 않는다.
   * 제안을 만들 때 여기서 받은 hash 를 참조한다.
   */
  app.post('/repos/:repoId/blobs', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    // viewer 도 제안을 올릴 수 있어야 하므로 열람 권한이면 충분하다.
    requireAccess(db, repoId, user.id, 'viewer');

    const part = await req.file();
    if (!part) throw badRequest('업로드할 파일이 없습니다.');

    const fileName = part.filename ?? '';
    const stored = await blobs.writeStream(part.file, config.maxUploadBytes);
    const mimeType = fileName ? mimeForPath(fileName) : DEFAULT_MIME;

    db.prepare(
      `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO NOTHING`,
    ).run(stored.hash, stored.size, mimeType, Date.now());

    return reply.code(201).send({
      blob: { hash: stored.hash, size: stored.size, mimeType, name: baseName(fileName) },
    });
  });
}

export interface SendBlobOptions {
  fileName: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

/** blob 을 스트림으로 내려준다. 파일이 사라졌으면 404. */
export async function sendBlob(
  reply: FastifyReply,
  ctx: AppContext,
  hash: string,
  options: SendBlobOptions,
): Promise<FastifyReply> {
  if (!(await ctx.blobs.has(hash))) throw notFound('파일 데이터를 찾을 수 없습니다.');

  const inline = options.inline && isInlineSafe(options.mimeType);
  const safeName = options.fileName.slice(0, MAX_NAME_LENGTH * 4) || 'download';

  return reply
    .header('Content-Type', options.mimeType || DEFAULT_MIME)
    .header('Content-Length', String(options.size))
    .header('Content-Disposition', contentDisposition(safeName, inline))
    // 콘텐츠 주소라 내용이 바뀌면 해시도 바뀐다 — 마음껏 캐시해도 된다.
    .header('Cache-Control', 'private, max-age=31536000, immutable')
    .header('X-Content-Type-Options', 'nosniff')
    .send(ctx.blobs.createReadStream(hash));
}
