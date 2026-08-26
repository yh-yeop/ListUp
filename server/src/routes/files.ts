import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_FILES_PER_REPO,
  MAX_NAME_LENGTH,
  baseName,
  normalizeDirPath,
  normalizePath,
} from '@listup/shared';
import type { Config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, notFound, tooLarge } from '../lib/errors.ts';
import { DEFAULT_MIME, isInlineSafe, mimeForPath } from '../lib/mime.ts';
import { body, queryString, requireUser, requiredString } from '../lib/request.ts';
import { manifestBytes } from '../services/proposals.ts';
import { getRepoRow, requireAccess } from '../services/repos.ts';
import {
  findPathConflict,
  listTree,
  readManifest,
  snapshotBelongsTo,
  writeSnapshot,
  type EntryRow,
} from '../services/snapshots.ts';

/** 파일명에 따옴표/개행이 들어가도 안전한 Content-Disposition 을 만든다. */
export function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 8187 의 attr-char 에는 `'()*` 가 없는데 encodeURIComponent 는 이들을 남겨 두므로 따로 인코딩한다.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 새 경로가 기존 파일/폴더와 이름 공간이 겹치면(파일 "a" 와 폴더 "a/") 409 를 던진다. */
export function assertNoPathConflict(manifest: Map<string, EntryRow>, filePath: string): void {
  const clash = findPathConflict(manifest, filePath);
  if (clash === null) return;
  throw conflict(
    clash.startsWith(`${filePath}/`)
      ? `같은 이름의 폴더가 이미 있습니다: ${filePath}`
      : `상위 경로에 파일이 있습니다: ${clash}`,
  );
}

/** 저장소 총 용량이 한도를 넘으면 413. 업로드·제안 생성·병합이 같은 메시지를 쓴다. */
export function assertRepoBytes(config: Config, totalBytes: number): void {
  if (totalBytes <= config.maxRepoBytes) return;
  throw tooLarge(
    `저장소 용량 한도(${Math.floor(config.maxRepoBytes / 1024 / 1024)}MB)를 넘습니다.`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
    requireAccess(db, repoId, user.id, 'editor');

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

    const result = db.transaction(() => {
      db.prepare(
        `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      ).run(stored.hash, stored.size, mimeType, now);

      // 스트림을 받는 동안 다른 커밋이 끼어들 수 있으므로 head 는 트랜잭션 안에서 다시 읽는다.
      // (권한 검사 때 읽은 값을 쓰면 그 사이 커밋된 파일이 새 스냅샷에서 빠진다)
      const current = getRepoRow(db, repoId);
      if (!current) throw notFound('저장소를 찾을 수 없습니다.');
      const head = current.head_snapshot_id;

      // 이 저장소로 올라온 blob 으로 기록해 두면 나중에 제안에도 담을 수 있다.
      db.prepare(
        `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
      ).run(repoId, stored.hash, user.id, now);

      const manifest = readManifest(db, head);
      const existing = manifest.get(filePath);
      if (!existing) {
        if (manifest.size >= MAX_FILES_PER_REPO) {
          throw conflict(`저장소당 파일은 최대 ${MAX_FILES_PER_REPO}개입니다.`);
        }
        assertNoPathConflict(manifest, filePath);
      }
      if (existing && existing.blob_hash === stored.hash) {
        // 내용이 같으면 새 스냅샷을 만들지 않는다.
        return { snapshotId: head, unchanged: true };
      }
      // 교체되는 파일의 크기는 빼고 결과 총량으로 한도를 본다.
      assertRepoBytes(config, manifestBytes(manifest) - (existing?.size ?? 0) + stored.size);

      manifest.set(filePath, {
        path: filePath,
        blob_hash: stored.hash,
        size: stored.size,
        mime_type: mimeType,
        updated_at: now,
      });

      const snapshotId = writeSnapshot(db, {
        repoId,
        parentId: head,
        authorId: user.id,
        message: `${existing ? '수정' : '추가'}: ${filePath}`,
        manifest,
        now,
      });
      return { snapshotId, unchanged: false };
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
      snapshotId: result.snapshotId,
      unchanged: result.unchanged,
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

      // 이동으로 사라지는 원본 경로는 빼고, 남는 항목과 새 경로가 겹치는지 본다.
      const remaining = new Map(manifest);
      for (const move of moves) remaining.delete(move.from);
      for (const move of moves) {
        if (remaining.has(move.to)) throw conflict(`이미 존재하는 경로입니다: ${move.to}`);
        assertNoPathConflict(remaining, move.to);
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
      // 스냅샷을 지정한 URL 은 내용이 고정이지만, head 기준 URL 은 같은 경로에 새 파일이 올라올 수 있다.
      cache: requested ? 'immutable' : 'revalidate',
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

    const quotaError = () =>
      tooLarge(
        `하루 업로드 한도(${Math.floor(config.maxStagingBytesPerDay / 1024 / 1024)}MB)를 넘었습니다.`,
      );
    /** 사용자가 최근 24시간 동안 스테이징에 올린 총량. */
    const stagedBytes = (since: number) =>
      db
        .prepare<[string, number], { total: number }>(
          `SELECT COALESCE(SUM(b.size), 0) AS total
             FROM repo_blobs rb JOIN blobs b ON b.hash = rb.hash
            WHERE rb.uploaded_by = ? AND rb.created_at > ?`,
        )
        .get(user.id, since)!.total;

    // 이미 한도를 다 쓴 사용자는 스트림을 받기 전에 거절해 디스크에 아무것도 쓰지 않는다.
    // (여기를 통과해도 아래 트랜잭션에서 다시 검사하므로, 초과분은 업로드 1건 크기로 제한된다)
    if (stagedBytes(Date.now() - DAY_MS) >= config.maxStagingBytesPerDay) {
      part.file.resume();
      throw quotaError();
    }

    const fileName = part.filename ?? '';
    const stored = await blobs.writeStream(part.file, config.maxUploadBytes);
    const mimeType = fileName ? mimeForPath(fileName) : DEFAULT_MIME;
    const now = Date.now();

    // 한도 초과로 거절할 때 이 요청이 처음 저장한 blob 파일이면 지워야 디스크가 차지 않는다.
    // (GC 가 없으므로 여기서 지우지 않으면 영영 남는다)
    const isNewBlob =
      db
        .prepare<[string], { ok: number }>(`SELECT 1 AS ok FROM blobs WHERE hash = ?`)
        .get(stored.hash) === undefined;

    try {
      db.transaction(() => {
        const already = db
          .prepare<[string, string], { ok: number }>(
            `SELECT 1 AS ok FROM repo_blobs WHERE repo_id = ? AND hash = ?`,
          )
          .get(repoId, stored.hash);
        if (!already) {
          // 어디에도 반영되지 않는 업로드로 디스크를 채우지 못하게 사용자별 하루 총량을 제한한다.
          // 같은 내용을 같은 저장소에 다시 올리는 것은 새로 저장되지 않으므로 세지 않는다.
          if (stagedBytes(now - DAY_MS) + stored.size > config.maxStagingBytesPerDay) {
            throw quotaError();
          }
        }

        db.prepare(
          `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(hash) DO NOTHING`,
        ).run(stored.hash, stored.size, mimeType, now);
        db.prepare(
          `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
        ).run(repoId, stored.hash, user.id, now);
      })();
    } catch (err) {
      if (isNewBlob) await blobs.remove(stored.hash);
      throw err;
    }

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
  /**
   * immutable: URL 이 특정 내용을 고정한다(스냅샷 지정, 제안 파일) — 1년 캐시.
   * revalidate: 같은 URL 의 내용이 바뀔 수 있다(head 기준 경로) — 매번 ETag 로 확인.
   */
  cache: 'immutable' | 'revalidate';
}

/** If-None-Match 에 이 blob 의 ETag 가 들어 있는지. 약한 태그(W/)와 `*` 도 인정한다. */
function etagMatches(header: string | undefined, hash: string): boolean {
  if (!header) return false;
  return header.split(',').some((raw) => {
    const tag = raw.trim().replace(/^W\//, '');
    return tag === '*' || tag === `"${hash}"` || tag === hash;
  });
}

/** blob 을 스트림으로 내려준다. 파일이 사라졌으면 404. */
export async function sendBlob(
  reply: FastifyReply,
  ctx: AppContext,
  hash: string,
  options: SendBlobOptions,
): Promise<FastifyReply> {
  if (!(await ctx.blobs.has(hash))) throw notFound('파일 데이터를 찾을 수 없습니다.');

  // 콘텐츠 주소라 해시가 곧 ETag 다. 내용이 바뀌면 해시도 바뀐다.
  const etag = `"${hash}"`;
  const cacheControl =
    options.cache === 'immutable' ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  const req = reply.request;

  if (etagMatches(req.headers['if-none-match'], hash)) {
    return reply.code(304).header('ETag', etag).header('Cache-Control', cacheControl).send();
  }

  const inline = options.inline && isInlineSafe(options.mimeType);
  const safeName = options.fileName.slice(0, MAX_NAME_LENGTH * 4) || 'download';

  reply
    .header('Content-Type', options.mimeType || DEFAULT_MIME)
    .header('Content-Length', String(options.size))
    .header('Content-Disposition', contentDisposition(safeName, inline))
    .header('Cache-Control', cacheControl)
    .header('ETag', etag)
    .header('X-Content-Type-Options', 'nosniff');

  // HEAD 는 헤더만 필요하다 — 파일 스트림을 열지 않는다.
  // (Fastify 의 자동 HEAD 라우트는 본문이 없으면 Content-Length 를 0 으로 덮어쓰므로 빈 스트림을 준다)
  if (req.method === 'HEAD') return reply.send(Readable.from([]));
  return reply.send(ctx.blobs.createReadStream(hash));
}
