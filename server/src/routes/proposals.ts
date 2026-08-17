import type { FastifyInstance } from 'fastify';
import type { ChangeOp, ProposalDetail, ProposalStatus } from '@listup/shared';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FILES_PER_REPO,
  baseName,
  hasRole,
  normalizePath,
} from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { mimeForPath } from '../lib/mime.ts';
import { newId } from '../lib/ids.ts';
import { body, optionalString, queryString, requireUser, requiredString } from '../lib/request.ts';
import { getRepoRow, requireAccess } from '../services/repos.ts';
import { readManifest, writeSnapshot } from '../services/snapshots.ts';
import {
  applyChanges,
  findConflicts,
  getProposalRow,
  readChanges,
  readComments,
  toChange,
  toProposal,
  type ChangeRow,
  type ProposalRow,
} from '../services/proposals.ts';
import { sendBlob } from './files.ts';

const MAX_CHANGES = 200;
const MAX_COMMENT_LENGTH = 2000;
const MAX_TITLE_LENGTH = 120;

interface ChangeInput {
  path: string;
  /** null 이거나 없으면 삭제 제안. */
  blobHash?: string | null;
}

export async function registerProposalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  /**
   * 변경 제안 만들기. 열람 권한만 있어도 올릴 수 있다 — 이게 초대받은 사람이
   * 남의 저장소에 기여하는 기본 경로다.
   */
  app.post('/repos/:repoId/proposals', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'viewer');
    const input = body(req);

    const title = requiredString(input, 'title', { max: MAX_TITLE_LENGTH, label: '제목' });
    const description = optionalString(input, 'description', {
      max: MAX_DESCRIPTION_LENGTH * 4,
      label: '설명',
    });

    const rawChanges = input.changes;
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

    const addCount = [...prepared.values()].filter((c) => c.op === 'add').length;
    if (base.size + addCount > MAX_FILES_PER_REPO) {
      throw conflict(`저장소당 파일은 최대 ${MAX_FILES_PER_REPO}개입니다.`);
    }

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
      ).run(proposalId, repoId, seq, title, description, user.id, repo.head_snapshot_id, now, now);

      const insert = db.prepare(
        `INSERT INTO proposal_changes
           (proposal_id, path, op, blob_hash, size, mime_type, base_blob_hash, base_size)
         VALUES (@proposal_id, @path, @op, @blob_hash, @size, @mime_type, @base_blob_hash, @base_size)`,
      );
      for (const change of prepared.values()) insert.run({ ...change, proposal_id: proposalId });
    })();

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

    const rows = (
      statusFilter
        ? db
            .prepare(`SELECT * FROM proposals WHERE repo_id = ? AND status = ? ORDER BY number DESC`)
            .all(repoId, statusFilter)
        : db.prepare(`SELECT * FROM proposals WHERE repo_id = ? ORDER BY number DESC`).all(repoId)
    ) as ProposalRow[];

    return { proposals: rows.map((row) => toProposal(db, row)) };
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
    if (row.status !== 'open') throw conflict('이미 처리된 제안입니다.');

    const merged = db.transaction(() => {
      // 트랜잭션 안에서 head 를 다시 읽어 동시 병합 경합을 막는다.
      const repo = getRepoRow(db, row.repo_id)!;
      const changes = readChanges(db, proposalId);
      if (changes.length === 0) throw conflict('변경 내용이 없는 제안입니다.');

      const conflicts = findConflicts(db, changes, row.base_snapshot_id, repo.head_snapshot_id);
      if (conflicts.length > 0) {
        throw conflict(
          '제안 이후 같은 파일이 바뀌어 병합할 수 없습니다. 최신 내용으로 다시 제안해 주세요.',
          { conflicts },
        );
      }

      const now = Date.now();
      const head = readManifest(db, repo.head_snapshot_id);
      const nextManifest = applyChanges(head, changes, now);

      const snapshotId = writeSnapshot(db, {
        repoId: row.repo_id,
        parentId: repo.head_snapshot_id,
        authorId: user.id,
        message: `제안 #${row.number} 병합: ${row.title}`,
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
    if (row.status === 'merged') throw conflict('이미 병합된 제안입니다.');
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

/** 제안 상세 — 현재 head 기준 병합 가능 여부를 함께 계산한다. */
export function detail(ctx: AppContext, proposalId: string): ProposalDetail {
  const { db } = ctx;
  const row = getProposalRow(db, proposalId)!;
  const repo = getRepoRow(db, row.repo_id)!;
  const changes = readChanges(db, proposalId);
  const conflicts =
    row.status === 'open' ? findConflicts(db, changes, row.base_snapshot_id, repo.head_snapshot_id) : [];

  return {
    ...toProposal(db, row),
    changes: changes.map(toChange),
    comments: readComments(db, proposalId),
    mergeable: row.status === 'open' && conflicts.length === 0 && changes.length > 0,
    conflicts,
  };
}
