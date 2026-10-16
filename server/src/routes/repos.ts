import type { FastifyInstance } from 'fastify';
import type { RepoStorage, Role } from '@listup/shared';
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, isRole } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import {
  body,
  optionalString,
  queryInt,
  queryString,
  requireUser,
  requiredString,
} from '../lib/request.ts';
import {
  getRepoRow,
  getRole,
  listMembers,
  requireAccess,
  toRepoSummary,
  type RepoRow,
} from '../services/repos.ts';
import { fetchMirrorManifest, getMirror, parseMirrorLink, syncMirror } from '../services/mirror.ts';
import { listSnapshots } from '../services/snapshots.ts';

/** 이 사람이 만든 미회수 초대를 모두 회수한다. 추방·강등과 같은 트랜잭션 안에서 부른다. */
function revokeInvitesBy(db: AppContext['db'], repoId: string, userId: string, now: number): void {
  db.prepare(
    `UPDATE invites SET revoked_at = ?
      WHERE repo_id = ? AND created_by = ? AND revoked_at IS NULL`,
  ).run(now, repoId, userId);
}

export async function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;

  /** 내가 참여 중인 저장소 목록. */
  app.get('/repos', async (req) => {
    const user = requireUser(req);
    const rows = db
      .prepare<[string], RepoRow & { role: Role }>(
        `SELECT r.*, m.role
           FROM repos r JOIN repo_members m ON m.repo_id = r.id
          WHERE m.user_id = ?
          ORDER BY r.updated_at DESC`,
      )
      .all(user.id);
    return { repos: rows.map((row) => toRepoSummary(db, row, row.role)) };
  });

  app.post('/repos', async (req, reply) => {
    const user = requireUser(req);
    const input = body(req);
    const name = requiredString(input, 'name', { max: MAX_NAME_LENGTH, label: '저장소 이름' });
    const description = optionalString(input, 'description', {
      max: MAX_DESCRIPTION_LENGTH,
      label: '설명',
    });

    const now = Date.now();
    const id = newId('repo');

    db.transaction(() => {
      db.prepare(
        `INSERT INTO repos (id, name, description, owner_id, head_snapshot_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, name, description, user.id, now, now);
      db.prepare(
        `INSERT INTO repo_members (repo_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
      ).run(id, user.id, now);
    })();

    const row = getRepoRow(db, id)!;
    return reply.code(201).send({ repo: toRepoSummary(db, row, 'owner') });
  });

  // -------------------------------------------------------------------------
  // 따라가기(미러) — 다른 서버의 저장소를 읽기 전용 사본으로
  // -------------------------------------------------------------------------

  /** 원본 서버의 따라가기 링크(`https://원본/s/<키>`)로 미러 저장소를 만든다. 첫 가져오기는 뒤에서 한다. */
  app.post('/repos/mirror', async (req, reply) => {
    const user = requireUser(req);
    const input = body(req);
    const link = typeof input.link === 'string' ? input.link : '';
    const parsed = parseMirrorLink(link);
    if (!parsed) throw badRequest('따라가기 링크가 올바르지 않습니다. 원본 서버에서 받은 https://…/s/… 링크를 넣어 주세요.');
    const exists = db
      .prepare<[string, string], { repo_id: string }>(
        `SELECT m.repo_id FROM mirrors m JOIN repo_members rm ON rm.repo_id = m.repo_id AND rm.user_id = ?
          WHERE m.source_token = ?`,
      )
      .get(user.id, parsed.token);
    if (exists) throw conflict('이미 이 저장소를 따라가고 있습니다.', { repoId: exists.repo_id });
    const manifest = await fetchMirrorManifest(parsed.sourceUrl, parsed.token);

    const now = Date.now();
    const id = newId('repo');
    const name = manifest.repo.name.trim().slice(0, MAX_NAME_LENGTH) || '따라가는 저장소';
    const description = String(manifest.repo.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO repos (id, name, description, owner_id, head_snapshot_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, name, description, user.id, now, now);
      db.prepare(`INSERT INTO repo_members (repo_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`).run(id, user.id, now);
      db.prepare(
        `INSERT INTO mirrors (repo_id, source_url, source_token, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, parsed.sourceUrl, parsed.token, now);
    })();
    // 큰 저장소는 오래 걸리므로 기다리지 않는다 — 상태는 저장소 요약의 mirror 로 본다.
    void syncMirror(ctx, id).catch((err) => req.log.warn({ err, repoId: id }, '미러 첫 가져오기 실패'));
    return reply.code(201).send({ repo: toRepoSummary(db, getRepoRow(db, id)!, 'owner') });
  });

  /** 지금 가져오기 — 소유자. 끝날 때까지 기다린다. */
  app.post('/repos/:repoId/mirror/sync', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'owner');
    if (!getMirror(db, repoId)) throw badRequest('따라가는 저장소가 아닙니다.');
    const result = await syncMirror(ctx, repoId);
    return { repo: toRepoSummary(db, getRepoRow(db, repoId)!, 'owner'), result };
  });

  /** 따라가기를 그만둔다 — 지금 가진 파일과 이력을 그대로 둔 채 보통 저장소가 된다. */
  app.delete('/repos/:repoId/mirror', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'owner');
    db.prepare(`DELETE FROM mirrors WHERE repo_id = ?`).run(repoId);
    return { repo: toRepoSummary(db, getRepoRow(db, repoId)!, 'owner') };
  });

  app.get('/repos/:repoId', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo, role } = requireAccess(db, repoId, user.id, 'viewer');
    return { repo: toRepoSummary(db, repo, role) };
  });

  app.patch('/repos/:repoId', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo, role } = requireAccess(db, repoId, user.id, 'owner');
    const input = body(req);

    const name =
      input.name === undefined
        ? repo.name
        : requiredString(input, 'name', { max: MAX_NAME_LENGTH, label: '저장소 이름' });
    const description =
      input.description === undefined
        ? repo.description
        : optionalString(input, 'description', {
            max: MAX_DESCRIPTION_LENGTH,
            label: '설명',
          });

    db.prepare(`UPDATE repos SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
      name,
      description,
      Date.now(),
      repoId,
    );
    return { repo: toRepoSummary(db, getRepoRow(db, repoId)!, role) };
  });

  app.delete('/repos/:repoId', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'owner');
    // blob 은 다른 저장소와 공유될 수 있으므로 지우지 않는다 (GC 는 별도 작업).
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // 멤버
  // -------------------------------------------------------------------------

  app.get('/repos/:repoId/members', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { role } = requireAccess(db, repoId, user.id, 'viewer');
    return { members: listMembers(db, repoId, role) };
  });

  app.patch('/repos/:repoId/members/:userId', async (req) => {
    const user = requireUser(req);
    const { repoId, userId } = req.params as { repoId: string; userId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'owner');
    const input = body(req);
    const role = input.role;
    if (!isRole(role) || role === 'owner') {
      throw badRequest('역할은 viewer 또는 editor 여야 합니다.');
    }
    if (userId === repo.owner_id) throw badRequest('소유자의 역할은 바꿀 수 없습니다.');
    if (!getRole(db, repoId, userId)) throw notFound('멤버를 찾을 수 없습니다.');

    db.transaction(() => {
      db.prepare(`UPDATE repo_members SET role = ? WHERE repo_id = ? AND user_id = ?`).run(
        role,
        repoId,
        userId,
      );
      // 초대는 편집자 이상만 만들 수 있으므로, 열람자로 강등되면 그 사람의 초대도 거둔다.
      if (role === 'viewer') revokeInvitesBy(db, repoId, userId, Date.now());
    })();
    return { members: listMembers(db, repoId, 'owner') };
  });

  app.delete('/repos/:repoId/members/:userId', async (req) => {
    const user = requireUser(req);
    const { repoId, userId } = req.params as { repoId: string; userId: string };
    const repo = getRepoRow(db, repoId);
    if (!repo || !getRole(db, repoId, user.id)) throw notFound('저장소를 찾을 수 없습니다.');

    // 소유자는 누구든 내보낼 수 있고, 그 외에는 자기 자신만 나갈 수 있다.
    const isSelf = userId === user.id;
    if (!isSelf && repo.owner_id !== user.id) throw forbidden('멤버를 내보낼 권한이 없습니다.');
    if (userId === repo.owner_id) {
      throw conflict('소유자는 나갈 수 없습니다. 저장소를 삭제하거나 소유권을 넘겨주세요.');
    }
    if (!getRole(db, repoId, userId)) throw notFound('멤버를 찾을 수 없습니다.');

    db.transaction(() => {
      db.prepare(`DELETE FROM repo_members WHERE repo_id = ? AND user_id = ?`).run(repoId, userId);
      // 나간 사람이 만든 초대로 다시 들어오거나 남을 들일 수 없게 한다.
      revokeInvitesBy(db, repoId, userId, Date.now());
    })();
    return { ok: true };
  });

  /** 소유권 넘기기 — 넘긴 사람은 editor 로 남는다. */
  app.post('/repos/:repoId/transfer', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'owner');
    const input = body(req);
    const targetId = requiredString(input, 'userId', { max: 64, label: '대상 사용자' });
    if (targetId === user.id) throw badRequest('이미 소유자입니다.');
    if (!getRole(db, repoId, targetId)) throw notFound('멤버를 찾을 수 없습니다.');

    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE repo_members SET role = 'owner' WHERE repo_id = ? AND user_id = ?`).run(
        repoId,
        targetId,
      );
      db.prepare(`UPDATE repo_members SET role = 'editor' WHERE repo_id = ? AND user_id = ?`).run(
        repoId,
        user.id,
      );
      db.prepare(`UPDATE repos SET owner_id = ?, updated_at = ? WHERE id = ?`).run(
        targetId,
        now,
        repoId,
      );
    })();

    return { repo: toRepoSummary(db, getRepoRow(db, repoId)!, 'editor') };
  });

  // -------------------------------------------------------------------------
  // 용량 — 지금 파일, 이력이 붙잡은 것, 중복, 큰 파일
  // -------------------------------------------------------------------------

  app.get('/repos/:repoId/storage', async (req): Promise<RepoStorage> => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'viewer');

    const current = db
      .prepare<[string], { files: number; bytes: number }>(
        `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM repo_files WHERE repo_id = ?`,
      )
      .get(repoId)!;
    const snapshots = db
      .prepare<[string], { n: number; oldest: number | null }>(
        `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM snapshots WHERE repo_id = ?`,
      )
      .get(repoId)!;
    const extra = db
      .prepare<[string, string, string], { bytes: number }>(
        `SELECT COALESCE(SUM(b.size), 0) AS bytes FROM blobs b
          WHERE b.hash IN (
                  SELECT c.blob_hash FROM snapshot_changes c JOIN snapshots s ON s.id = c.snapshot_id
                   WHERE s.repo_id = ? AND c.blob_hash IS NOT NULL
                  UNION
                  SELECT c.prev_blob_hash FROM snapshot_changes c JOIN snapshots s ON s.id = c.snapshot_id
                   WHERE s.repo_id = ? AND c.prev_blob_hash IS NOT NULL)
            AND b.hash NOT IN (SELECT blob_hash FROM repo_files WHERE repo_id = ?)`,
      )
      .get(repoId, repoId, repoId)!;
    const groups = db
      .prepare<[string], { hash: string; size: number; n: number }>(
        `SELECT blob_hash AS hash, MAX(size) AS size, COUNT(*) AS n FROM repo_files
          WHERE repo_id = ? GROUP BY blob_hash HAVING COUNT(*) > 1
          ORDER BY MAX(size) * (COUNT(*) - 1) DESC`,
      )
      .all(repoId);
    const pathsOf = db.prepare<[string, string], { path: string }>(
      `SELECT path FROM repo_files WHERE repo_id = ? AND blob_hash = ? ORDER BY path`,
    );
    const largest = db
      .prepare<[string], { path: string; size: number }>(
        `SELECT path, size FROM repo_files WHERE repo_id = ? ORDER BY size DESC, path LIMIT 10`,
      )
      .all(repoId);

    return {
      current,
      history: { snapshots: snapshots.n, oldestAt: snapshots.oldest, extraBytes: extra.bytes },
      duplicates: groups.slice(0, 50).map((group) => ({
        hash: group.hash,
        size: group.size,
        paths: pathsOf.all(repoId, group.hash).map((row) => row.path),
      })),
      duplicateBytes: groups.reduce((sum, group) => sum + group.size * (group.n - 1), 0),
      largest,
      retention: { days: config.historyDays, keepOlder: config.historyKeepOlder },
    };
  });

  // -------------------------------------------------------------------------
  // 변경 이력
  // -------------------------------------------------------------------------

  app.get('/repos/:repoId/history', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'viewer');
    const limit = queryInt(req, 'limit', 30, 100);
    // 커서는 (created_at, id) 쌍이다. 같은 밀리초에 만들어진 스냅샷을 건너뛰지 않기 위해서다.
    const beforeRaw = queryString(req, 'before');
    const beforeId = queryString(req, 'beforeId');
    const before = beforeRaw ? Number.parseInt(beforeRaw, 10) : Number.NaN;
    const cursor = Number.isFinite(before) && beforeId ? { before, beforeId } : undefined;
    const snapshots = listSnapshots(db, repoId, limit, cursor);
    const last = snapshots[snapshots.length - 1];
    return {
      snapshots,
      next: snapshots.length === limit && last ? { before: last.createdAt, beforeId: last.id } : null,
    };
  });
}
