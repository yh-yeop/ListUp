import type { FastifyInstance } from 'fastify';
import type { Invite, InvitePreview, Role } from '@listup/shared';
import { parseInviteCode } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, newInviteCode } from '../lib/ids.ts';
import { body, requireUser } from '../lib/request.ts';
import { getRepoRow, getRole, requireAccess, toRepoSummary } from '../services/repos.ts';
import { snapshotStats } from '../services/snapshots.ts';

interface InviteRow {
  id: string;
  repo_id: string;
  code: string;
  role: Exclude<Role, 'owner'>;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: number | null;
}

function isActive(row: InviteRow, now: number): boolean {
  if (row.revoked_at !== null) return false;
  if (row.expires_at !== null && row.expires_at <= now) return false;
  if (row.max_uses !== null && row.use_count >= row.max_uses) return false;
  return true;
}

function toInvite(row: InviteRow, now: number): Invite {
  return {
    id: row.id,
    repoId: row.repo_id,
    code: row.code,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
    active: isActive(row, now),
  };
}

const MAX_EXPIRY_DAYS = 365;
const MAX_USES = 10_000;

export async function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  /** 초대 코드 발급. 편집자 이상이면 발급할 수 있다. */
  app.post('/repos/:repoId/invites', async (req, reply) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'editor');
    const input = body(req);

    const role = input.role === undefined ? 'viewer' : input.role;
    if (role !== 'viewer' && role !== 'editor') {
      throw badRequest('초대 역할은 viewer 또는 editor 여야 합니다.');
    }

    let expiresAt: number | null = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
      const days = Number(input.expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
        throw badRequest(`만료 기간은 1~${MAX_EXPIRY_DAYS}일 사이여야 합니다.`);
      }
      expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    }

    let maxUses: number | null = null;
    if (input.maxUses !== undefined && input.maxUses !== null) {
      const uses = Number(input.maxUses);
      if (!Number.isInteger(uses) || uses <= 0 || uses > MAX_USES) {
        throw badRequest(`사용 횟수는 1~${MAX_USES} 사이여야 합니다.`);
      }
      maxUses = uses;
    }

    // UNIQUE 충돌은 사실상 없지만, 만약을 대비해 몇 번 다시 시도한다.
    let row: InviteRow | undefined;
    for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
      const candidate: InviteRow = {
        id: newId('inv'),
        repo_id: repoId,
        code: newInviteCode(),
        role,
        created_by: user.id,
        created_at: Date.now(),
        expires_at: expiresAt,
        max_uses: maxUses,
        use_count: 0,
        revoked_at: null,
      };
      try {
        db.prepare(
          `INSERT INTO invites (id, repo_id, code, role, created_by, created_at, expires_at, max_uses, use_count, revoked_at)
           VALUES (@id, @repo_id, @code, @role, @created_by, @created_at, @expires_at, @max_uses, @use_count, @revoked_at)`,
        ).run(candidate);
        row = candidate;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      }
    }
    if (!row) throw conflict('초대 코드를 만들지 못했습니다. 다시 시도해 주세요.');

    return reply.code(201).send({ invite: toInvite(row, Date.now()) });
  });

  app.get('/repos/:repoId/invites', async (req) => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'editor');
    const now = Date.now();
    const rows = db
      .prepare<[string], InviteRow>(
        `SELECT * FROM invites WHERE repo_id = ? ORDER BY created_at DESC`,
      )
      .all(repoId);
    return { invites: rows.map((row) => toInvite(row, now)) };
  });

  /** 초대 회수. 발급자 본인 또는 소유자만. */
  app.delete('/invites/:inviteId', async (req) => {
    const user = requireUser(req);
    const { inviteId } = req.params as { inviteId: string };
    const row = db.prepare<[string], InviteRow>(`SELECT * FROM invites WHERE id = ?`).get(inviteId);
    if (!row) throw notFound('초대를 찾을 수 없습니다.');

    const { repo } = requireAccess(db, row.repo_id, user.id, 'editor');
    if (row.created_by !== user.id && repo.owner_id !== user.id) {
      throw forbidden('내가 만든 초대만 회수할 수 있습니다.');
    }
    if (row.revoked_at === null) {
      db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ?`).run(Date.now(), inviteId);
    }
    return { ok: true };
  });

  /**
   * 참여 전 미리보기. 로그인은 필요하지만 멤버가 아니어도 볼 수 있다.
   * (어떤 저장소에 들어가는지 모르고 참여하는 일을 막는다)
   */
  app.get('/invites/:code', async (req) => {
    const user = requireUser(req);
    const { code: rawCode } = req.params as { code: string };
    const row = lookupInvite(db, rawCode);
    const repoId = row.repo_id;

    const repo = getRepoRow(db, repoId);
    if (!repo) throw notFound('저장소가 이미 삭제되었습니다.');

    // 이미 멤버라면 코드가 소진·만료됐어도 어떤 저장소인지 보여준다.
    const currentRole = getRole(db, repoId, user.id);
    if (!currentRole) assertUsable(row);

    const owner = db
      .prepare<[string], { display_name: string }>(`SELECT display_name FROM users WHERE id = ?`)
      .get(repo.owner_id);
    const memberCount = db
      .prepare<[string], { c: number }>(`SELECT COUNT(*) AS c FROM repo_members WHERE repo_id = ?`)
      .get(repoId)!.c;

    const preview: InvitePreview = {
      code: row.code,
      role: row.role,
      repo: { id: repo.id, name: repo.name, description: repo.description },
      owner: { id: repo.owner_id, displayName: owner?.display_name ?? '알 수 없음' },
      memberCount,
      fileCount: snapshotStats(db, repo.head_snapshot_id).fileCount,
      currentRole,
    };
    return { invite: preview };
  });

  /** 초대 코드로 참여. */
  app.post('/invites/:code/join', async (req) => {
    const user = requireUser(req);
    const { code: rawCode } = req.params as { code: string };
    const row = lookupInvite(db, rawCode);
    const repoId = row.repo_id;

    const repo = getRepoRow(db, repoId);
    if (!repo) throw notFound('저장소가 이미 삭제되었습니다.');

    // 이미 멤버면 사용 횟수를 소모하지 않는다 — 링크를 두 번 눌렀다고 해서
    // 다른 사람이 쓸 자리를 빼앗아서는 안 된다.
    const existing = getRole(db, repoId, user.id);
    if (existing) {
      return { repo: toRepoSummary(db, repo, existing), alreadyMember: true };
    }
    assertUsable(row);

    const now = Date.now();
    db.transaction(() => {
      // 동시에 여러 명이 마지막 한 자리를 쓰는 경우를 막기 위해
      // use_count 조건을 UPDATE 문 자체에 넣는다.
      const result = db
        .prepare(
          `UPDATE invites SET use_count = use_count + 1
            WHERE id = ?
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (max_uses IS NULL OR use_count < max_uses)`,
        )
        .run(row.id, now);
      if (result.changes === 0) throw conflict('사용할 수 없는 초대 코드입니다.');

      db.prepare(
        `INSERT INTO repo_members (repo_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
      ).run(repoId, user.id, row.role, now);
    })();

    return { repo: toRepoSummary(db, getRepoRow(db, repoId)!, row.role), alreadyMember: false };
  });
}

/** 코드 문자열을 검증하고 초대를 찾는다. 사용 가능 여부는 보지 않는다. */
function lookupInvite(db: AppContext['db'], rawCode: string): InviteRow {
  const code = parseInviteCode(rawCode);
  if (!code) throw badRequest('초대 코드 형식이 올바르지 않습니다.');

  const row = db.prepare<[string], InviteRow>(`SELECT * FROM invites WHERE code = ?`).get(code);
  if (!row) throw notFound('초대 코드를 찾을 수 없습니다.');
  return row;
}

/** 지금 이 코드로 새로 참여할 수 있는지. 이미 멤버인 경우에는 부르지 않는다. */
function assertUsable(row: InviteRow): void {
  const now = Date.now();
  if (row.revoked_at !== null) throw conflict('회수된 초대 코드입니다.');
  if (row.expires_at !== null && row.expires_at <= now) throw conflict('만료된 초대 코드입니다.');
  if (row.max_uses !== null && row.use_count >= row.max_uses) {
    throw conflict('사용 횟수를 모두 쓴 초대 코드입니다.');
  }
}
