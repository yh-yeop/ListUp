import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { ChangeOp, ConflictResolution, ProposalConflict, ProposalDetail, ProposalStatus } from '@listup/shared';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FILES_PER_REPO,
  baseName,
  hasRole,
  normalizePath,
} from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { MAX_MERGE_BYTES, decodeText, merge3 } from '../lib/merge.ts';

/** 상세를 볼 때마다 다시 합쳐 보지 않게 — (원본, 저장소, 제안) 세 해시로 기억한다. */
const mergeCache = new Map<string, Buffer | null>();
const MERGE_CACHE_SIZE = 200;
/** 상세 하나에서 자동 병합을 시험해 보는 최대 충돌 수 — 그 뒤 것은 정리 때 고르면 그때 계산한다. */
const MAX_AUTOMERGE_PROBES = 20;
import { mimeForPath } from '../lib/mime.ts';
import { newId } from '../lib/ids.ts';
import { body, optionalString, queryInt, queryString, requireUser, requiredString } from '../lib/request.ts';
import { assertWritable } from '../services/mirror.ts';
import { getRepoRow, requireAccess } from '../services/repos.ts';
import { readManifest, writeSnapshot, type EntryRow } from '../services/snapshots.ts';
import {
  applyChanges,
  blobBelongsToRepo,
  findConflicts,
  findPathConflicts,
  getProposalRow,
  manifestBytes,
  readChanges,
  readComments,
  toChange,
  toProposal,
  type ChangeRow,
  type ProposalRow,
} from '../services/proposals.ts';
import { assertRepoBytes, sendBlob } from './files.ts';

const MAX_CHANGES = 200;
const MAX_COMMENT_LENGTH = 2000;
const MAX_TITLE_LENGTH = 120;

interface ChangeInput {
  path: string;
  /** null 이거나 없으면 삭제 제안. */
  blobHash?: string | null;
}

export async function registerProposalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;

  /**
   * 변경 제안 만들기. 열람 권한만 있어도 올릴 수 있다 — 이게 초대받은 사람이
   * 남의 저장소에 기여하는 기본 경로다.
   */
  app.post('/repos/:repoId/proposals', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'viewer');
    assertWritable(db, repoId);
    const input = body(req);

    const title = requiredString(input, 'title', { max: MAX_TITLE_LENGTH, label: '제목' });
    const description = optionalString(input, 'description', {
      max: MAX_DESCRIPTION_LENGTH * 4,
      label: '설명',
    });

    const proposalId = createProposal(ctx, {
      repoId,
      authorId: user.id,
      title,
      description,
      rawChanges: input.changes,
    });
    return reply.code(201).send({ proposal: detail(ctx, proposalId) });
  });

  app.get('/repos/:repoId/proposals', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'viewer');

    const statusFilter = queryString(req, 'status');
    const valid: ProposalStatus[] = ['open', 'merged', 'closed'];
    if (statusFilter && !valid.includes(statusFilter as ProposalStatus)) {
      throw badRequest('status 값이 올바르지 않습니다.');
    }

    // 페이지는 `limit` 을 줄 때만 나눈다 — 주지 않는 옛 앱(1.3.0 까지)은 전부를 받던 그대로다.
    // 커서는 제안 번호다. 저장소 안에서 겹치지 않고 늘기만 하므로 그것 하나로 충분하다.
    const limit = queryString(req, 'limit') === undefined ? null : queryInt(req, 'limit', 30, 100);
    const beforeRaw = queryString(req, 'before');
    const before = beforeRaw === undefined ? Number.NaN : Number.parseInt(beforeRaw, 10);
    if (beforeRaw !== undefined && !(Number.isSafeInteger(before) && before > 0)) {
      throw badRequest('before 값이 올바르지 않습니다.');
    }

    const where = ['repo_id = ?'];
    const params: (string | number)[] = [repoId];
    if (statusFilter) {
      where.push('status = ?');
      params.push(statusFilter);
    }
    if (beforeRaw !== undefined) {
      where.push('number < ?');
      params.push(before);
    }
    // 하나 더 읽어 다음 페이지가 있는지 안다 — 딱 limit 개로 끝날 때 빈 페이지를 한 번 더 부르지 않게.
    if (limit !== null) params.push(limit + 1);
    const rows = db
      .prepare(
        `SELECT * FROM proposals WHERE ${where.join(' AND ')} ORDER BY number DESC` +
          (limit !== null ? ' LIMIT ?' : ''),
      )
      .all(...params) as ProposalRow[];

    const hasMore = limit !== null && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      proposals: page.map((row) => toProposal(db, row)),
      next: hasMore ? { before: page[page.length - 1].number } : null,
    };
  });

  app.get('/proposals/:proposalId', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    requireAccess(db, row.repo_id, user.id, 'viewer');
    return { proposal: detail(ctx, proposalId) };
  });

  /** 제안에 담긴 파일 내려받기 — 병합 전에 내용을 확인할 수 있어야 한다. */
  app.get('/proposals/:proposalId/raw', async (req, reply) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    requireAccess(db, row.repo_id, user.id, 'viewer');

    const rawPath = queryString(req, 'path');
    if (!rawPath) throw badRequest('경로가 필요합니다.');
    const path = normalizePath(rawPath);
    if (!path) throw badRequest('경로가 올바르지 않습니다.');

    const change = db
      .prepare<[string, string], ChangeRow>(
        `SELECT * FROM proposal_changes WHERE proposal_id = ? AND path = ?`,
      )
      .get(proposalId, path);
    if (!change || !change.blob_hash) throw notFound('제안에 해당 파일이 없습니다.');

    return sendBlob(reply, ctx, change.blob_hash, {
      fileName: baseName(change.path),
      mimeType: change.mime_type ?? mimeForPath(change.path),
      size: change.size,
      inline: queryString(req, 'inline') === '1',
      // 제안의 변경 내용은 만들어진 뒤 바뀌지 않는다.
      cache: 'immutable',
    });
  });

  app.post('/proposals/:proposalId/comments', async (req, reply) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    requireAccess(db, row.repo_id, user.id, 'viewer');

    const text = requiredString(body(req), 'body', { max: MAX_COMMENT_LENGTH, label: '댓글' });
    const now = Date.now();
    db.prepare(
      `INSERT INTO proposal_comments (id, proposal_id, author_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(newId('cmt'), proposalId, user.id, text, now);
    db.prepare(`UPDATE proposals SET updated_at = ? WHERE id = ?`).run(now, proposalId);

    return reply.code(201).send({ comments: readComments(db, proposalId) });
  });

  /** 병합 — 편집 권한이 필요하다. 충돌이 있으면 409. */
  app.post('/proposals/:proposalId/merge', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    requireAccess(db, row.repo_id, user.id, 'editor');
    assertWritable(db, row.repo_id);
    if (row.status !== 'open') throw conflict('이미 처리된 제안입니다.');

    const merged = db.transaction(() => {
      // 트랜잭션 안에서 head 를 다시 읽어 동시 병합 경합을 막는다.
      const repo = getRepoRow(db, row.repo_id)!;
      const changes = readChanges(db, proposalId);
      if (changes.length === 0) throw conflict('변경 내용이 없는 제안입니다.');

      const conflicts = findConflicts(db, changes, row.base_snapshot_id, repo.head_snapshot_id);
      if (conflicts.length > 0) {
        throw conflict(
          '제안 이후 같은 파일이 바뀌어 반영할 수 없습니다. 최신 내용으로 다시 제안해 주세요.',
          { conflicts },
        );
      }

      const head = readManifest(db, repo.head_snapshot_id);
      // 제안 이후 head 에 같은 이름의 파일/폴더가 생겼을 수 있다 (예: 제안은 "a/b" 추가, head 에 파일 "a").
      const pathConflicts = findPathConflicts(head, changes);
      if (pathConflicts.length > 0) {
        throw conflict('제안 이후 이름이 겹치는 파일이나 폴더가 생겨 반영할 수 없습니다.', {
          conflicts: pathConflicts,
        });
      }

      const now = Date.now();
      const nextManifest = applyChanges(head, changes, now);
      if (nextManifest.size > MAX_FILES_PER_REPO) {
        throw conflict(`저장소당 파일은 최대 ${MAX_FILES_PER_REPO}개입니다.`);
      }
      assertRepoBytes(config, manifestBytes(nextManifest));

      const snapshotId = writeSnapshot(db, {
        repoId: row.repo_id,
        parentId: repo.head_snapshot_id,
        authorId: user.id,
        message: `제안 #${row.number} 반영: ${row.title}`,
        manifest: nextManifest,
        now,
      });

      db.prepare(
        `UPDATE proposals SET status = 'merged', merged_snapshot_id = ?, updated_at = ? WHERE id = ?`,
      ).run(snapshotId, now, proposalId);

      return snapshotId;
    })();

    return { proposal: detail(ctx, proposalId), snapshotId: merged };
  });

  /**
   * 충돌 정리 — 작성자 본인 또는 편집자 이상. 지금의 충돌 경로마다 정리 방법을 하나씩 받는다(빠짐없이).
   * 정리하면 제안의 기준을 지금 저장소로 옮겨, 다시 충돌 없이 반영할 수 있게 된다. 무엇을 골랐는지는 댓글로 남긴다.
   * "충돌 난 것만 빼고 반영"은 모두 theirs 로 정리한 뒤 반영하면 된다.
   */
  app.post('/proposals/:proposalId/resolve', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'viewer');
    if (row.author_id !== user.id && !hasRole(role, 'editor')) {
      throw forbidden('작성자 또는 편집자만 충돌을 정리할 수 있습니다.');
    }
    if (row.status !== 'open') throw conflict('열려 있는 제안만 정리할 수 있습니다.');
    assertWritable(db, row.repo_id);

    const raw = body(req).resolutions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('resolutions 가 필요합니다.');
    const resolutions = new Map<string, ConflictResolution>();
    for (const [path, choice] of Object.entries(raw as Record<string, unknown>)) {
      if (choice !== 'mine' && choice !== 'theirs' && choice !== 'merge') {
        throw badRequest(`정리 방법이 올바르지 않습니다: ${path}`);
      }
      resolutions.set(path, choice);
    }

    const repo = getRepoRow(db, row.repo_id)!;
    const headId = repo.head_snapshot_id;
    const head = readManifest(db, headId);
    const changes = readChanges(db, proposalId);
    const byPath = new Map(changes.map((change) => [change.path, change]));
    const changed = new Set(findConflicts(db, changes, row.base_snapshot_id, headId));
    const named = new Set(findPathConflicts(head, changes));
    if (changed.size + named.size === 0) throw conflict('정리할 충돌이 없습니다.');
    for (const path of [...changed, ...named]) {
      if (!resolutions.has(path)) throw badRequest(`정리 방법을 고르지 않은 충돌이 있습니다: ${path}`, { missing: path });
    }
    for (const [path, choice] of resolutions) {
      if (!changed.has(path) && !named.has(path)) throw badRequest(`충돌이 아닌 경로입니다: ${path}`);
      if (named.has(path) && choice !== 'theirs') {
        throw badRequest(`이름이 겹친 경로는 제안에서 빼는 것만 됩니다: ${path}`);
      }
    }

    // 자동 병합은 먼저 계산해 blob 으로 써 둔다(파일 쓰기는 트랜잭션 밖에서).
    const merged = new Map<string, { hash: string; size: number }>();
    for (const [path, choice] of resolutions) {
      if (choice !== 'merge') continue;
      const content = mergedContent(ctx, byPath.get(path)!, head.get(path));
      if (!content) throw conflict(`자동으로 합칠 수 없습니다(같은 줄을 둘 다 고쳤거나 텍스트가 아님): ${path}`, { conflicts: [path] });
      merged.set(path, await ctx.blobs.writeBuffer(content));
    }

    const now = Date.now();
    db.transaction(() => {
      if (getRepoRow(db, row.repo_id)!.head_snapshot_id !== headId) {
        throw conflict('그 사이 저장소가 바뀌었습니다. 다시 확인한 뒤 정리해 주세요.');
      }
      // 합치는 동안(파일 쓰기) 제안이 닫혔거나 다른 정리가 끼어들었으면 그 위에 덮지 않는다.
      const fresh = getProposalRow(db, proposalId);
      const freshChanges = readChanges(db, proposalId);
      if (
        !fresh ||
        fresh.status !== 'open' ||
        fresh.base_snapshot_id !== row.base_snapshot_id ||
        freshChanges.length !== changes.length ||
        freshChanges.some((c, i) => c.path !== changes[i].path || c.blob_hash !== changes[i].blob_hash)
      ) {
        throw conflict('그 사이 제안이 바뀌었습니다. 다시 확인한 뒤 정리해 주세요.');
      }
      const remove = db.prepare(`DELETE FROM proposal_changes WHERE proposal_id = ? AND path = ?`);
      const rebase = db.prepare(
        `UPDATE proposal_changes SET op = ?, blob_hash = ?, size = ?, mime_type = ?, base_blob_hash = ?, base_size = ?
          WHERE proposal_id = ? AND path = ?`,
      );
      const notes: string[] = [];
      for (const [path, choice] of resolutions) {
        const change = byPath.get(path)!;
        const current = head.get(path);
        if (choice === 'theirs') {
          remove.run(proposalId, path);
          notes.push(`${path}: 저장소 내용 유지 (제안에서 뺌)`);
          continue;
        }
        let blobHash = change.blob_hash;
        let size = change.size;
        if (choice === 'merge') {
          const blob = merged.get(path)!;
          db.prepare(
            `INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
          ).run(blob.hash, blob.size, mimeForPath(path), now);
          db.prepare(
            `INSERT OR IGNORE INTO repo_blobs (repo_id, hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)`,
          ).run(row.repo_id, blob.hash, user.id, now);
          blobHash = blob.hash;
          size = blob.size;
        }
        // 지금 저장소와 똑같아졌으면(삭제 제안인데 이미 지워짐 등) 바꿀 것이 없으니 뺀다.
        if ((blobHash === null && !current) || (blobHash !== null && current?.blob_hash === blobHash)) {
          remove.run(proposalId, path);
          notes.push(`${path}: 이미 저장소와 같음 (제안에서 뺌)`);
          continue;
        }
        const op: ChangeOp = blobHash === null ? 'delete' : current ? 'update' : 'add';
        rebase.run(op, blobHash, blobHash === null ? 0 : size, blobHash === null ? null : mimeForPath(path),
          current?.blob_hash ?? null, current?.size ?? null, proposalId, path);
        notes.push(choice === 'merge' ? `${path}: 줄 단위로 자동으로 합침` : `${path}: 제안 내용 유지 (저장소의 변경을 덮어씀)`);
      }
      db.prepare(`UPDATE proposals SET base_snapshot_id = ?, updated_at = ? WHERE id = ?`).run(headId, now, proposalId);
      db.prepare(
        `INSERT INTO proposal_comments (id, proposal_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(newId('cmt'), proposalId, user.id, `충돌을 정리했습니다.\n${notes.map((note) => `· ${note}`).join('\n')}`, now);
    })();
    return { proposal: detail(ctx, proposalId) };
  });

  /** 닫기 — 작성자 본인 또는 편집자 이상. */
  app.post('/proposals/:proposalId/close', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'viewer');
    if (row.author_id !== user.id && !hasRole(role, 'editor')) {
      throw forbidden('작성자 또는 편집자만 닫을 수 있습니다.');
    }
    if (row.status === 'merged') throw conflict('이미 반영된 제안입니다.');
    if (row.status === 'closed') return { proposal: detail(ctx, proposalId) };

    db.prepare(`UPDATE proposals SET status = 'closed', updated_at = ? WHERE id = ?`).run(
      Date.now(),
      proposalId,
    );
    return { proposal: detail(ctx, proposalId) };
  });

  app.post('/proposals/:proposalId/reopen', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    const { role } = requireAccess(db, row.repo_id, user.id, 'viewer');
    if (row.author_id !== user.id && !hasRole(role, 'editor')) {
      throw forbidden('작성자 또는 편집자만 다시 열 수 있습니다.');
    }
    if (row.status !== 'closed') throw conflict('닫힌 제안만 다시 열 수 있습니다.');

    db.prepare(`UPDATE proposals SET status = 'open', updated_at = ? WHERE id = ?`).run(
      Date.now(),
      proposalId,
    );
    return { proposal: detail(ctx, proposalId) };
  });

  /** 제목·설명 수정 (작성자만). */
  app.patch('/proposals/:proposalId', async (req) => {
    const user = requireUser(req);
    const { proposalId } = req.params as { proposalId: string };
    const row = getProposalRow(db, proposalId);
    if (!row) throw notFound('제안을 찾을 수 없습니다.');
    requireAccess(db, row.repo_id, user.id, 'viewer');
    if (row.author_id !== user.id) throw forbidden('작성자만 수정할 수 있습니다.');
    // 병합·닫힌 제안은 기록이므로 제목·설명도 고정한다.
    if (row.status !== 'open') throw conflict('열린 제안만 수정할 수 있습니다.');

    const input = body(req);
    const title =
      input.title === undefined
        ? row.title
        : requiredString(input, 'title', { max: MAX_TITLE_LENGTH, label: '제목' });
    const description =
      input.description === undefined
        ? row.description
        : optionalString(input, 'description', {
            max: MAX_DESCRIPTION_LENGTH * 4,
            label: '설명',
          });

    db.prepare(`UPDATE proposals SET title = ?, description = ?, updated_at = ? WHERE id = ?`).run(
      title,
      description,
      Date.now(),
      proposalId,
    );
    return { proposal: detail(ctx, proposalId) };
  });
}

/**
 * 제안 이후 저장소에서도 바뀐 텍스트 파일을 줄 단위로 합친다. 합칠 수 없으면(텍스트가 아님, 너무 큼, 같은 줄을
 * 둘 다 고침) null. 파일이 작으므로(1MB 까지) 그대로 읽는다.
 */
function mergedContent(ctx: AppContext, change: ChangeRow, headEntry: EntryRow | undefined): Buffer | null {
  if (change.op === 'delete' || !change.blob_hash || !change.base_blob_hash || !headEntry) return null;
  if (change.size > MAX_MERGE_BYTES || (change.base_size ?? Infinity) > MAX_MERGE_BYTES || headEntry.size > MAX_MERGE_BYTES) {
    return null;
  }
  const key = `${change.base_blob_hash}|${headEntry.blob_hash}|${change.blob_hash}`;
  const cached = mergeCache.get(key);
  if (cached !== undefined) return cached;
  let merged: Buffer | null = null;
  try {
    const read = (hash: string) => decodeText(fs.readFileSync(ctx.blobs.pathFor(hash)));
    const base = read(change.base_blob_hash);
    const theirs = read(headEntry.blob_hash);
    const mine = read(change.blob_hash);
    if (base !== null && theirs !== null && mine !== null) {
      const result = merge3(base, theirs, mine);
      merged = result.ok ? Buffer.from(result.text, 'utf8') : null;
    }
  } catch {
    merged = null;
  }
  if (mergeCache.size >= MERGE_CACHE_SIZE) mergeCache.delete(mergeCache.keys().next().value!);
  mergeCache.set(key, merged);
  return merged;
}

/** 제안 상세 — 현재 head 기준 병합 가능 여부를 함께 계산한다. */
export function detail(ctx: AppContext, proposalId: string): ProposalDetail {
  const { db } = ctx;
  const row = getProposalRow(db, proposalId)!;
  const repo = getRepoRow(db, row.repo_id)!;
  const changes = readChanges(db, proposalId);
  // 병합을 막는 경로: base 이후 head 에서 바뀐 파일 + head 의 파일/폴더와 이름이 겹치게 된 추가 항목.
  let conflictDetails: ProposalConflict[] = [];
  if (row.status === 'open') {
    const head = readManifest(db, repo.head_snapshot_id);
    const byPath = new Map(changes.map((change) => [change.path, change]));
    conflictDetails = [
      ...findConflicts(db, changes, row.base_snapshot_id, repo.head_snapshot_id).map((path, index) => ({
        path,
        reason: 'changed' as const,
        ...(index < MAX_AUTOMERGE_PROBES ? { autoMerge: mergedContent(ctx, byPath.get(path)!, head.get(path)) !== null } : {}),
      })),
      ...findPathConflicts(head, changes).map((path) => ({ path, reason: 'name' as const })),
    ];
  }
  const conflicts = conflictDetails.map((conflict) => conflict.path);

  return {
    ...toProposal(db, row),
    changes: changes.map(toChange),
    comments: readComments(db, proposalId),
    mergeable: row.status === 'open' && conflicts.length === 0 && changes.length > 0,
    conflicts,
    conflictDetails,
  };
}

export interface CreateProposalParams {
  repoId: string;
  authorId: string;
  title: string;
  description: string;
  /** 요청 본문 그대로의 changes — 여기서 검사한다. */
  rawChanges: unknown;
  /** 받기 함으로 들어온 손님 제안이면 손님이 적은 이름과 그 링크. author 는 링크를 만든 사람이다. */
  guestName?: string;
  shareId?: string;
}

/**
 * 변경 제안을 만든다 — 멤버의 제안과 받기 함 손님의 제안이 같은 검사를 거친다. 만든 제안 id 를 돌려준다.
 * op(추가/수정/삭제)는 받지 않고 지금 저장소를 보고 정한다.
 */
export function createProposal(ctx: AppContext, params: CreateProposalParams): string {
  const { db, config } = ctx;
  const { repoId, rawChanges, title, description } = params;
  const repo = getRepoRow(db, repoId)!;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    throw badRequest('변경 내용이 없습니다. 파일을 추가하거나 삭제해 주세요.');
  }
  if (rawChanges.length > MAX_CHANGES) {
    throw badRequest(`한 제안에는 최대 ${MAX_CHANGES}개의 파일만 담을 수 있습니다.`);
  }

  const base = readManifest(db, repo.head_snapshot_id);
  const prepared = new Map<string, Omit<ChangeRow, 'proposal_id'>>();

  for (const raw of rawChanges as ChangeInput[]) {
    if (!raw || typeof raw !== 'object') throw badRequest('변경 항목 형식이 올바르지 않습니다.');
    const path = normalizePath(String(raw.path ?? ''));
    if (!path) throw badRequest(`경로가 올바르지 않습니다: ${String(raw.path)}`);
    if (prepared.has(path)) throw badRequest(`같은 경로가 두 번 들어 있습니다: ${path}`);

    const baseEntry = base.get(path) ?? null;
    const blobHash = raw.blobHash ?? null;

    if (blobHash === null) {
      // 삭제 제안
      if (!baseEntry) throw badRequest(`없는 파일은 삭제할 수 없습니다: ${path}`);
      prepared.set(path, {
        path,
        op: 'delete',
        blob_hash: null,
        size: 0,
        mime_type: null,
        base_blob_hash: baseEntry.blob_hash,
        base_size: baseEntry.size,
      });
      continue;
    }

    if (typeof blobHash !== 'string' || !/^[0-9a-f]{64}$/.test(blobHash)) {
      throw badRequest(`blobHash 형식이 올바르지 않습니다: ${path}`);
    }
    const blob = db
      .prepare<[string], { hash: string; size: number }>(
        `SELECT hash, size FROM blobs WHERE hash = ?`,
      )
      .get(blobHash);
    if (!blob) throw badRequest(`먼저 파일을 업로드해 주세요: ${path}`);
    // 다른 저장소에서 알아낸 해시로 남의 파일을 끌어오는 것을 막는다.
    if (!blobBelongsToRepo(db, repoId, blobHash)) {
      throw badRequest(`이 저장소에 올린 파일만 제안에 담을 수 있습니다: ${path}`);
    }

    if (baseEntry && baseEntry.blob_hash === blobHash) {
      throw badRequest(`내용이 그대로입니다: ${path}`);
    }

    const op: ChangeOp = baseEntry ? 'update' : 'add';
    prepared.set(path, {
      path,
      op,
      blob_hash: blobHash,
      size: blob.size,
      mime_type: mimeForPath(path),
      base_blob_hash: baseEntry?.blob_hash ?? null,
      base_size: baseEntry?.size ?? null,
    });
  }

  // 제안 안에서 파일과 폴더 이름이 겹치면(예: "a" 와 "a/b") 병합 결과가 성립하지 않는다.
  for (const path of prepared.keys()) {
    for (let idx = path.indexOf('/'); idx !== -1; idx = path.indexOf('/', idx + 1)) {
      const ancestor = path.slice(0, idx);
      if (prepared.has(ancestor)) {
        throw badRequest(`제안 안에서 경로가 겹칩니다: ${ancestor} 와 ${path}`);
      }
    }
  }

  const changes = [...prepared.values()];
  const addCount = changes.filter((c) => c.op === 'add').length;
  if (base.size + addCount > MAX_FILES_PER_REPO) {
    throw conflict(`저장소당 파일은 최대 ${MAX_FILES_PER_REPO}개입니다.`);
  }
  const pathConflicts = findPathConflicts(base, changes);
  if (pathConflicts.length > 0) {
    throw conflict(
      `기존 파일·폴더와 이름이 겹치는 경로가 있습니다: ${pathConflicts.join(', ')}`,
      { conflicts: pathConflicts },
    );
  }
  // base 총량에 추가·수정분을 더하고 교체·삭제되는 원본 크기를 뺀 결과로 한도를 본다.
  let bytes = manifestBytes(base);
  for (const change of changes) bytes += change.size - (change.base_size ?? 0);
  assertRepoBytes(config, bytes);

  const now = Date.now();
  const proposalId = newId('prop');

  db.transaction(() => {
    const seq = (db
      .prepare<[string], { proposal_seq: number }>(`SELECT proposal_seq FROM repos WHERE id = ?`)
      .get(repoId)!.proposal_seq) + 1;
    db.prepare(`UPDATE repos SET proposal_seq = ? WHERE id = ?`).run(seq, repoId);

    db.prepare(
      `INSERT INTO proposals
         (id, repo_id, number, title, description, status, author_id, base_snapshot_id, merged_snapshot_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?)`,
    ).run(proposalId, repoId, seq, title, description, params.authorId, repo.head_snapshot_id, now, now);
    if (params.guestName !== undefined) {
      db.prepare(`UPDATE proposals SET guest_name = ?, share_id = ? WHERE id = ?`).run(
        params.guestName,
        params.shareId ?? null,
        proposalId,
      );
    }

    const insert = db.prepare(
      `INSERT INTO proposal_changes
         (proposal_id, path, op, blob_hash, size, mime_type, base_blob_hash, base_size)
       VALUES (@proposal_id, @path, @op, @blob_hash, @size, @mime_type, @base_blob_hash, @base_size)`,
    );
    for (const change of prepared.values()) insert.run({ ...change, proposal_id: proposalId });
  })();
  return proposalId;
}
