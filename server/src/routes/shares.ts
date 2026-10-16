import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  baseName,
  extName,
  hasRole,
  normalizeDirPath,
  normalizePath,
  type MirrorManifest,
  type PublicShare,
  type Share,
  type ShareKind,
} from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, notFound, tooLarge } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { body, optionalString, requireUser, requiredString } from '../lib/request.ts';
import { assertWritable } from '../services/mirror.ts';
import { getRole, requireAccess } from '../services/repos.ts';
import { readEntry, readManifest } from '../services/snapshots.ts';
import { toSession, uploadEngine, type SessionRow } from '../services/uploads.ts';
import { sendArchive } from './downloads.ts';
import { sendBlob } from './files.ts';
import { createProposal, detail } from './proposals.ts';

/**
 * 공개 링크 — 저장소 밖의 사람(계정 없음)과 다른 서버에게 주는 링크.
 *
 * 멤버 쪽 (로그인)
 *   POST   /repos/:repoId/shares   {kind, path?, label?, expiresInDays?, maxUses?, maxMb?}  → {share}
 *   GET    /repos/:repoId/shares                                                    → {shares}
 *   DELETE /shares/:shareId                                                         → 회수
 *
 * 링크 쪽 (로그인 없음, 토큰이 곧 권한)
 *   GET  /s/:token                       어떤 링크인지 (+ download 면 받을 수 있는 파일)
 *   GET  /s/:token/raw?path=             download: 파일 하나 (이어받기 가능)
 *   GET  /s/:token/zip                   download: 폴더를 zip 으로
 *   POST /s/:token/uploads ...           upload: 나눠 올리기 (멤버의 것과 같은 엔진)
 *   POST /s/:token/submit                upload: 올린 파일들을 변경 제안 하나로 보낸다
 *   GET  /s/:token/mirror                mirror: 저장소의 지금 모습 (다른 서버가 따라간다)
 *   GET  /s/:token/mirror/blobs/:hash    mirror: 지금 파일의 내용
 *
 * 링크를 만들 수 있는 사람: download·upload 는 편집자 이상, mirror 는 소유자. 만든 사람이 그 권한을 잃으면
 * 링크도 쓸 수 없다(초대와 같은 규칙). 토큰은 18바이트 무작위라 떠보아 찾을 수 없다.
 */

const MAX_LABEL = 60;
const MAX_GUEST_NAME = 40;
const MAX_MESSAGE = 2000;
const MAX_SUBMIT_FILES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ShareRow {
  id: string;
  repo_id: string;
  kind: ShareKind;
  path: string;
  token: string;
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  use_count: number;
  max_bytes: number | null;
  used_bytes: number;
  revoked_at: number | null;
}

/** 만들 수 있는(그리고 계속 쓸 수 있는) 최소 권한. */
const REQUIRED_ROLE = { download: 'editor', upload: 'editor', mirror: 'owner' } as const;

export async function registerShareRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;
  const engine = uploadEngine(ctx);

  /** 회수·만료·소진, 만든 사람의 권한, 저장소가 그대로인지. 쓸 수 없으면 그 이유. */
  function problemOf(row: ShareRow, now = Date.now()): string | null {
    if (row.revoked_at !== null) return '회수된 링크입니다.';
    if (row.expires_at !== null && row.expires_at <= now) return '기간이 끝난 링크입니다.';
    if (row.max_uses !== null && row.use_count >= row.max_uses) return '정해진 횟수를 다 쓴 링크입니다.';
    const role = getRole(db, row.repo_id, row.created_by);
    if (!hasRole(role, REQUIRED_ROLE[row.kind])) return '링크를 만든 사람이 더 이상 이 저장소를 관리하지 않습니다.';
    return null;
  }

  function toShare(row: ShareRow): Share {
    const creator = db.prepare<[string], { display_name: string }>(`SELECT display_name FROM users WHERE id = ?`).get(row.created_by);
    return {
      id: row.id,
      repoId: row.repo_id,
      kind: row.kind,
      path: row.path,
      token: row.token,
      label: row.label,
      createdBy: { id: row.created_by, displayName: creator?.display_name ?? '알 수 없음' },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
      maxBytes: row.max_bytes,
      usedBytes: row.used_bytes,
      revokedAt: row.revoked_at,
      active: problemOf(row) === null,
    };
  }

  /** 토큰으로 링크를 찾는다. 없으면 404, 쓸 수 없으면 409 (어떤 이유인지는 알려 준다). */
  function requireShare(req: FastifyRequest, kind: ShareKind): ShareRow {
    const { token } = req.params as { token: string };
    const row =
      typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token)
        ? db.prepare<[string], ShareRow>(`SELECT * FROM shares WHERE token = ?`).get(token)
        : undefined;
    if (!row || row.kind !== kind) throw notFound('링크를 찾을 수 없습니다.');
    const problem = problemOf(row);
    if (problem) throw conflict(problem);
    return row;
  }

  const headOf = (repoId: string) =>
    db.prepare<[string], { head_snapshot_id: string | null; name: string; description: string }>(
      `SELECT head_snapshot_id, name, description FROM repos WHERE id = ?`,
    ).get(repoId)!;

  // -------------------------------------------------------------------------
  // 멤버 쪽
  // -------------------------------------------------------------------------

  app.post('/repos/:repoId/shares', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const input = body(req);
    const kind = input.kind;
    if (kind !== 'download' && kind !== 'upload' && kind !== 'mirror') throw badRequest('kind 는 download·upload·mirror 중 하나입니다.');
    const { role } = requireAccess(db, repoId, user.id, 'viewer');
    if (!hasRole(role, REQUIRED_ROLE[kind])) {
      throw forbidden(kind === 'mirror' ? '따라가기 키는 소유자만 만들 수 있습니다.' : '링크는 편집 권한이 있어야 만들 수 있습니다.');
    }
    if (kind === 'upload') assertWritable(db, repoId);
    const label = optionalString(input, 'label', { max: MAX_LABEL, label: '이름' });

    let path = '';
    if (kind !== 'mirror') {
      const raw = typeof input.path === 'string' ? input.path : '';
      const normalized = normalizeDirPath(raw);
      if (normalized === null) throw badRequest('경로가 올바르지 않습니다.');
      path = normalized;
    }
    if (kind === 'download') {
      const head = headOf(repoId).head_snapshot_id;
      const manifest = readManifest(db, head);
      const exists = path === '' ? manifest.size > 0 : manifest.has(path) || [...manifest.keys()].some((p) => p.startsWith(`${path}/`));
      if (!exists) throw notFound('그 경로에 파일이 없습니다.');
    }

    const days = input.expiresInDays;
    let expiresAt: number | null = null;
    if (days !== undefined && days !== null) {
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
        throw badRequest('기간은 1~365일 사이의 정수여야 합니다.');
      }
      expiresAt = Date.now() + days * DAY_MS;
    } else if (kind !== 'mirror' && !('expiresInDays' in input)) {
      // 기본 7일. 기한 없는 링크는 null 을 명시해야 만든다.
      expiresAt = Date.now() + 7 * DAY_MS;
    }
    const maxUses = input.maxUses ?? null;
    if (maxUses !== null && (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000)) {
      throw badRequest('횟수는 1~10000 사이의 정수여야 합니다.');
    }
    let maxBytes: number | null = null;
    if (kind === 'upload') {
      const maxMb = input.maxMb ?? Math.floor(config.maxStagingBytesPerDay / 1024 / 1024);
      if (typeof maxMb !== 'number' || !Number.isInteger(maxMb) || maxMb < 1) throw badRequest('용량은 1MB 이상의 정수여야 합니다.');
      maxBytes = Math.min(maxMb * 1024 * 1024, config.maxRepoBytes);
    }

    const row: ShareRow = {
      id: newId('shr'),
      repo_id: repoId,
      kind,
      path,
      token: randomBytes(18).toString('base64url'),
      label,
      created_by: user.id,
      created_at: Date.now(),
      expires_at: expiresAt,
      max_uses: kind === 'mirror' ? null : (maxUses as number | null),
      use_count: 0,
      max_bytes: maxBytes,
      used_bytes: 0,
      revoked_at: null,
    };
    db.prepare(
      `INSERT INTO shares (id, repo_id, kind, path, token, label, created_by, created_at, expires_at, max_uses, max_bytes)
       VALUES (@id, @repo_id, @kind, @path, @token, @label, @created_by, @created_at, @expires_at, @max_uses, @max_bytes)`,
    ).run(row);
    return reply.code(201).send({ share: toShare(row) });
  });

  app.get('/repos/:repoId/shares', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { role } = requireAccess(db, repoId, user.id, 'editor');
    const rows = db
      .prepare<[string], ShareRow>(`SELECT * FROM shares WHERE repo_id = ? ORDER BY created_at DESC`)
      .all(repoId)
      // 따라가기 키는 소유자만 본다 — 저장소 전체를 가져갈 수 있는 열쇠다.
      .filter((row) => row.kind !== 'mirror' || role === 'owner');
    return { shares: rows.map(toShare) };
  });

  app.delete('/shares/:shareId', async (req) => {
    const user = requireUser(req);
    const { shareId } = req.params as { shareId: string };
    const row = db.prepare<[string], ShareRow>(`SELECT * FROM shares WHERE id = ?`).get(shareId);
    if (!row) throw notFound('링크를 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'editor');
    if (row.created_by !== user.id && role !== 'owner') throw forbidden('만든 사람이나 소유자만 회수할 수 있습니다.');
    if (row.revoked_at === null) db.prepare(`UPDATE shares SET revoked_at = ? WHERE id = ?`).run(Date.now(), shareId);
    return { share: toShare(db.prepare<[string], ShareRow>(`SELECT * FROM shares WHERE id = ?`).get(shareId)!) };
  });

  // -------------------------------------------------------------------------
  // 링크 쪽 — 받기
  // -------------------------------------------------------------------------

  /** 링크 대상 안의 상대 경로를 저장소 경로로. 대상이 파일이면 '' 만. */
  function resolveDownload(row: ShareRow, relative: string): { path: string; isFile: boolean } {
    const repo = headOf(row.repo_id);
    const isFile = row.path !== '' && readEntry(db, repo.head_snapshot_id ?? '', row.path) !== undefined;
    if (isFile) {
      if (relative !== '') throw notFound('파일을 찾을 수 없습니다.');
      return { path: row.path, isFile };
    }
    const rel = normalizePath(relative);
    if (!rel) throw badRequest('경로가 올바르지 않습니다.');
    return { path: row.path ? `${row.path}/${rel}` : rel, isFile };
  }

  /** 받은 횟수를 센다. 이어받기(0 이 아닌 곳부터의 Range)·HEAD 는 세지 않는다. */
  function countDownload(req: FastifyRequest, row: ShareRow): void {
    if (req.method === 'HEAD') return;
    const range = req.headers.range;
    if (typeof range === 'string' && !/^bytes=0-/.test(range)) return;
    db.prepare(`UPDATE shares SET use_count = use_count + 1 WHERE id = ?`).run(row.id);
  }

  app.get('/s/:token', async (req): Promise<{ share: PublicShare }> => {
    const { token } = req.params as { token: string };
    const peek = db.prepare<[string], ShareRow>(`SELECT * FROM shares WHERE token = ?`).get(String(token));
    if (!peek || peek.kind === 'mirror') throw notFound('링크를 찾을 수 없습니다.');
    const row = requireShare(req, peek.kind);
    const repo = headOf(row.repo_id);
    const base: PublicShare = {
      kind: row.kind as 'download' | 'upload',
      label: row.label,
      repoName: repo.name,
      name: row.path === '' ? '' : baseName(row.path),
      isFile: false,
      expiresAt: row.expires_at,
    };
    if (row.kind === 'upload') {
      return {
        share: {
          ...base,
          remainingBytes: row.max_bytes === null ? null : Math.max(0, row.max_bytes - row.used_bytes),
          maxFileBytes: config.maxUploadBytes,
        },
      };
    }
    const manifest = readManifest(db, repo.head_snapshot_id);
    const file = row.path === '' ? undefined : manifest.get(row.path);
    if (file) return { share: { ...base, isFile: true, files: [{ path: '', size: file.size }] } };
    const prefix = row.path === '' ? '' : `${row.path}/`;
    const files = [...manifest.values()]
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size }))
      .sort((a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true }));
    if (files.length === 0) throw notFound('링크의 파일이 더 이상 없습니다.');
    return { share: { ...base, files } };
  });

  app.get('/s/:token/raw', async (req, reply) => {
    const row = requireShare(req, 'download');
    const relative = String((req.query as { path?: unknown }).path ?? '');
    const { path } = resolveDownload(row, relative);
    const head = headOf(row.repo_id).head_snapshot_id;
    const entry = head ? readEntry(db, head, path) : undefined;
    if (!entry) throw notFound('파일을 찾을 수 없습니다.');
    countDownload(req, row);
    return sendBlob(reply, ctx, entry.blob_hash, {
      fileName: baseName(entry.path),
      mimeType: entry.mime_type,
      size: entry.size,
      inline: (req.query as { inline?: unknown }).inline === '1',
      cache: 'revalidate',
    });
  });

  app.get('/s/:token/zip', async (req, reply) => {
    const row = requireShare(req, 'download');
    const repo = headOf(row.repo_id);
    if (row.path !== '' && readManifest(db, repo.head_snapshot_id).has(row.path)) {
      throw badRequest('파일 하나짜리 링크입니다 — 그대로 받아 주세요.');
    }
    countDownload(req, row);
    return sendArchive(reply, ctx, repo.name, repo.head_snapshot_id, row.path);
  });

  // -------------------------------------------------------------------------
  // 링크 쪽 — 받기 함 (올리기)
  // -------------------------------------------------------------------------

  /** 받기 함 세션 — 이 링크로 연 것만. */
  function requireGuestSession(req: FastifyRequest): { share: ShareRow; row: SessionRow } {
    const share = requireShare(req, 'upload');
    const { uploadId } = req.params as { uploadId: string };
    const row = db
      .prepare<[string, string], SessionRow>(`SELECT * FROM upload_sessions WHERE id = ? AND share_id = ?`)
      .get(uploadId, share.id);
    if (!row) throw notFound('올리기 세션을 찾을 수 없습니다.');
    return { share, row };
  }

  const remaining = (share: ShareRow) =>
    share.max_bytes === null ? Infinity : share.max_bytes - share.used_bytes;

  app.post('/s/:token/uploads', async (req, reply) => {
    const share = requireShare(req, 'upload');
    const input = body(req);
    const name = baseName(requiredString(input, 'name', { max: 255, label: '파일 이름' }));
    const size = input.size;
    if (typeof size !== 'number') throw badRequest('파일 크기가 올바르지 않습니다.');
    const hash = typeof input.hash === 'string' ? input.hash : null;
    const result = await engine.start({
      repoId: share.repo_id,
      userId: share.created_by,
      name,
      size,
      hash,
      shareId: share.id,
      allowInstant: false,
      checkQuota: (bytes) => {
        if (bytes > remaining(share)) throw tooLarge('이 받기 함에 남은 용량을 넘습니다.');
      },
    });
    return reply.code(201).send(result);
  });

  app.get('/s/:token/uploads/:uploadId', async (req) => ({ upload: toSession(requireGuestSession(req).row) }));

  app.put('/s/:token/uploads/:uploadId', async (req) => {
    const { row } = requireGuestSession(req);
    const offset = Number((req.query as { offset?: string }).offset);
    return { upload: await engine.putChunk(row, offset, req.body as Readable | undefined, req.headers['content-type']) };
  });

  app.post('/s/:token/uploads/:uploadId/complete', async (req, reply) => {
    const { share, row } = requireGuestSession(req);
    const blob = await engine.complete(row, share.created_by, {
      onRecord: (stored) => {
        // 같은 트랜잭션 안에서 다시 읽어 동시에 끝나는 올리기끼리 한도를 넘지 않게 한다.
        const fresh = db.prepare<[string], ShareRow>(`SELECT * FROM shares WHERE id = ?`).get(share.id)!;
        if (stored.size > remaining(fresh)) throw tooLarge('이 받기 함에 남은 용량을 넘습니다.');
        db.prepare(`UPDATE shares SET used_bytes = used_bytes + ? WHERE id = ?`).run(stored.size, share.id);
      },
    });
    return reply.code(201).send({ blob });
  });

  app.delete('/s/:token/uploads/:uploadId', async (req) => {
    const { row } = requireGuestSession(req);
    await engine.cancel(row);
    return { ok: true };
  });

  /**
   * 올린 파일들을 변경 제안 하나로 보낸다. 받기 함은 기존 파일을 덮어쓰지 않는다 — 같은 이름이 있으면
   * "이름 (1).확장자" 로 더한다. 편집자가 검토한 뒤 반영한다.
   */
  app.post('/s/:token/submit', async (req, reply) => {
    const share = requireShare(req, 'upload');
    const input = body(req);
    const guestName = requiredString(input, 'name', { max: MAX_GUEST_NAME, label: '이름' });
    const message = optionalString(input, 'message', { max: MAX_MESSAGE, label: '메시지' }) ?? '';
    const files = input.files;
    if (!Array.isArray(files) || files.length === 0) throw badRequest('보낼 파일이 없습니다.');
    if (files.length > MAX_SUBMIT_FILES) throw badRequest(`한 번에 최대 ${MAX_SUBMIT_FILES}개까지 보낼 수 있습니다.`);

    const head = readManifest(db, headOf(share.repo_id).head_snapshot_id);
    const taken = new Set(head.keys());
    const isTaken = (path: string) =>
      taken.has(path) || [...taken].some((p) => p.startsWith(`${path}/`) || path.startsWith(`${p}/`));
    const changes: { path: string; blobHash: string }[] = [];
    for (const raw of files as { path?: unknown; blobHash?: unknown }[]) {
      const relative = typeof raw?.path === 'string' ? normalizePath(raw.path) : null;
      if (!relative) throw badRequest('경로가 올바르지 않습니다.');
      if (typeof raw.blobHash !== 'string') throw badRequest(`파일 내용이 없습니다: ${relative}`);
      let path = share.path ? `${share.path}/${relative}` : relative;
      if (isTaken(path)) {
        const ext = extName(path);
        const stem = ext ? path.slice(0, -(ext.length + 1)) : path;
        for (let i = 1; isTaken(path); i += 1) path = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`;
      }
      taken.add(path);
      changes.push({ path, blobHash: raw.blobHash });
    }

    const title = `${share.label || '받기 함'} — ${guestName} 님이 ${changes.length}개 보냄`.slice(0, 120);
    const proposalId = createProposal(ctx, {
      repoId: share.repo_id,
      authorId: share.created_by,
      title,
      description: message,
      rawChanges: changes,
      guestName,
      shareId: share.id,
    });
    db.prepare(`UPDATE shares SET use_count = use_count + 1 WHERE id = ?`).run(share.id);
    const { number } = detail(ctx, proposalId);
    return reply.code(201).send({ ok: true, number, files: changes.map((change) => change.path.slice(share.path ? share.path.length + 1 : 0)) });
  });

  // -------------------------------------------------------------------------
  // 링크 쪽 — 따라가기(미러)
  // -------------------------------------------------------------------------

  app.get('/s/:token/mirror', async (req): Promise<MirrorManifest> => {
    const share = requireShare(req, 'mirror');
    const repo = headOf(share.repo_id);
    const files = [...readManifest(db, repo.head_snapshot_id).values()].map((entry) => ({
      path: entry.path,
      blobHash: entry.blob_hash,
      size: entry.size,
      mimeType: entry.mime_type,
      updatedAt: entry.updated_at,
    }));
    return { repo: { name: repo.name, description: repo.description }, head: repo.head_snapshot_id, files };
  });

  app.get('/s/:token/mirror/blobs/:hash', async (req, reply) => {
    const share = requireShare(req, 'mirror');
    const { hash } = req.params as { hash: string };
    // 지금 파일의 내용만 — 따라가는 쪽은 지금 모습만 복제한다.
    const entry = db
      .prepare<[string, string], { size: number; mime_type: string }>(
        `SELECT size, mime_type FROM repo_files WHERE repo_id = ? AND blob_hash = ? LIMIT 1`,
      )
      .get(share.repo_id, String(hash));
    if (!entry) throw notFound('지금 저장소에 없는 내용입니다.');
    return sendBlob(reply, ctx, String(hash), {
      fileName: String(hash),
      mimeType: 'application/octet-stream',
      size: entry.size,
      inline: false,
      cache: 'immutable',
    });
  });
}
