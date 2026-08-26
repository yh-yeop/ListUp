import type { FastifyInstance } from 'fastify';
import type { Role } from '@listup/shared';
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
import { listSnapshots } from '../services/snapshots.ts';

/** 이 사람이 만든 미회수 초대를 모두 회수한다. 추방·강등과 같은 트랜잭션 안에서 부른다. */
function revokeInvitesBy(db: AppContext['db'], repoId: string, userId: string, now: number): void {
  db.prepare(
    `UPDATE invites SET revoked_at = ?
      WHERE repo_id = ? AND created_by = ? AND revoked_at IS NULL`,
  ).run(now, repoId, userId);
}

export async function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

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
