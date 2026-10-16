import type { FastifyInstance } from 'fastify';
import { baseName, type SearchHit, type SearchResult } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { queryInt, queryString, requireUser } from '../lib/request.ts';
import { requireAccess } from '../services/repos.ts';

/**
 * 파일 찾기 — 이름·경로에 글자가 들어 있는 지금 파일.
 *
 *   GET /repos/:repoId/search?q=&limit=    저장소 하나
 *   GET /search?q=&limit=                  내가 속한 저장소 전부
 *
 * 내용은 보지 않는다(순수 파일 공유). 대소문자는 구분하지 않고(ASCII), 글자는 NFC 로 맞춰 견준다 —
 * 경로가 NFC 로 저장되므로 맥에서 치는 분해형 한글도 맞는다. 이름에 맞은 것이 경로 중간에 맞은 것보다 앞에 온다.
 */

const MAX_QUERY = 100;

interface Row {
  repo_id: string;
  repo_name: string;
  path: string;
  blob_hash: string;
  size: number;
  mime_type: string;
  updated_at: number;
}

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  function parse(req: Parameters<typeof queryString>[0]): { q: string; limit: number } {
    const raw = (queryString(req, 'q') ?? '').normalize('NFC').trim();
    if (!raw) throw badRequest('찾을 글자를 넣어 주세요.');
    if ([...raw].length > MAX_QUERY) throw badRequest(`찾을 글자는 ${MAX_QUERY}자까지입니다.`);
    return { q: raw, limit: queryInt(req, 'limit', 50, 200) };
  }

  /** SQLite 의 lower() 는 ASCII 만 바꾼다 — 한글은 대소문자가 없으니 그대로다. */
  function run(where: string, params: unknown[], q: string, limit: number): SearchResult {
    const rows = db
      .prepare<unknown[], Row>(
        `SELECT f.repo_id, r.name AS repo_name, f.path, f.blob_hash, f.size, f.mime_type, f.updated_at
           FROM repo_files f JOIN repos r ON r.id = f.repo_id
          WHERE ${where} AND instr(lower(f.path), lower(?)) > 0
          ORDER BY f.updated_at DESC
          LIMIT ?`,
      )
      .all(...params, q, limit + 1);
    const needle = q.toLowerCase();
    const hits: SearchHit[] = rows.slice(0, limit).map((row) => ({
      repoId: row.repo_id,
      repoName: row.repo_name,
      path: row.path,
      name: baseName(row.path),
      blobHash: row.blob_hash,
      size: row.size,
      mimeType: row.mime_type,
      updatedAt: row.updated_at,
      nameMatch: baseName(row.path).toLowerCase().includes(needle),
    }));
    hits.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.updatedAt - a.updatedAt);
    return { hits, truncated: rows.length > limit };
  }

  app.get('/repos/:repoId/search', async (req): Promise<SearchResult> => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    requireAccess(db, repoId, user.id, 'viewer');
    const { q, limit } = parse(req);
    return run('f.repo_id = ?', [repoId], q, limit);
  });

  app.get('/search', async (req): Promise<SearchResult> => {
    const user = requireUser(req);
    const { q, limit } = parse(req);
    return run('f.repo_id IN (SELECT repo_id FROM repo_members WHERE user_id = ?)', [user.id], q, limit);
  });
}
