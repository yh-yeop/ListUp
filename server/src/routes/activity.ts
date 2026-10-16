import type { FastifyInstance } from 'fastify';
import type { ActivityItem } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { queryInt, queryString, requireUser } from '../lib/request.ts';

/**
 * 새 소식 — 내가 속한 저장소들에서 최근에 있었던 일을 시간순으로.
 *
 *   GET /activity?since=&limit=   since(ms) 뒤의 것만, 최근 것부터
 *
 * 따로 적어 두지 않고 있는 표(snapshots·proposals·proposal_comments)를 합쳐 만든다 — 저장할 것이 없고 뒤늦게 켜도
 * 옛일까지 보인다. 앱이 "마지막으로 본 시각"을 기기에 두고 그 뒤의 것 중 내가 한 일이 아닌 것을 "읽지 않음"으로 센다.
 */

interface Row {
  kind: ActivityItem['kind'];
  at: number;
  repo_id: string;
  repo_name: string;
  actor_id: string;
  actor_name: string;
  title: string;
  proposal_id: string | null;
  proposal_number: number | null;
  /** 받기 함 손님이 한 일 — 링크를 만든 멤버가 작성자로 적혀 있지만 그 사람이 한 일은 아니다. */
  guest: number;
}

export async function registerActivityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get('/activity', async (req): Promise<{ items: ActivityItem[] }> => {
    const user = requireUser(req);
    const sinceRaw = queryString(req, 'since');
    const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
    const limit = queryInt(req, 'limit', 50, 200);
    const rows = db
      .prepare<[string, number, string, number, string, number, number], Row>(
        `SELECT * FROM (
           SELECT 'commit' AS kind, s.created_at AS at, s.repo_id, r.name AS repo_name,
                  s.author_id AS actor_id, u.display_name AS actor_name, s.message AS title,
                  NULL AS proposal_id, NULL AS proposal_number, 0 AS guest
             FROM snapshots s JOIN repos r ON r.id = s.repo_id JOIN users u ON u.id = s.author_id
            WHERE s.repo_id IN (SELECT repo_id FROM repo_members WHERE user_id = ?) AND s.created_at > ?
           UNION ALL
           -- 반영한 사람은 반영 스냅샷의 작성자다(제안자가 아니라). 닫은 사람은 따로 적지 않아 제안자로 둔다.
           SELECT CASE p.status WHEN 'merged' THEN 'proposal-merged' WHEN 'closed' THEN 'proposal-closed' ELSE 'proposal-opened' END,
                  CASE WHEN p.status = 'open' THEN p.created_at ELSE p.updated_at END, p.repo_id, r.name,
                  COALESCE(ms.author_id, p.author_id), COALESCE(mu.display_name, p.guest_name, u.display_name), p.title, p.id, p.number,
                  p.guest_name IS NOT NULL AND ms.author_id IS NULL
             FROM proposals p JOIN repos r ON r.id = p.repo_id JOIN users u ON u.id = p.author_id
             LEFT JOIN snapshots ms ON ms.id = p.merged_snapshot_id LEFT JOIN users mu ON mu.id = ms.author_id
            WHERE p.repo_id IN (SELECT repo_id FROM repo_members WHERE user_id = ?)
              AND (CASE WHEN p.status = 'open' THEN p.created_at ELSE p.updated_at END) > ?
           UNION ALL
           SELECT 'comment', c.created_at, p.repo_id, r.name, c.author_id, u.display_name, c.body, p.id, p.number, 0
             FROM proposal_comments c JOIN proposals p ON p.id = c.proposal_id
             JOIN repos r ON r.id = p.repo_id JOIN users u ON u.id = c.author_id
            WHERE p.repo_id IN (SELECT repo_id FROM repo_members WHERE user_id = ?) AND c.created_at > ?
         ) ORDER BY at DESC, kind LIMIT ?`,
      )
      .all(user.id, since, user.id, since, user.id, since, limit);
    return {
      items: rows.map((row) => ({
        kind: row.kind,
        at: row.at,
        repoId: row.repo_id,
        repoName: row.repo_name,
        actor: { id: row.actor_id, displayName: row.actor_name },
        title: row.title.length > 120 ? `${row.title.slice(0, 120)}…` : row.title,
        ...(row.proposal_id ? { proposalId: row.proposal_id, proposalNumber: row.proposal_number ?? undefined } : {}),
        mine: row.actor_id === user.id && !row.guest,
      })),
    };
  });
}
