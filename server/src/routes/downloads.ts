import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import yazl from 'yazl';
import { baseName, normalizeDirPath, normalizePath, type DownloadLink } from '@listup/shared';
import type { AppContext } from '../context.ts';
import { issueDownloadLink, verifyDownloadLink } from '../lib/download-links.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { body, requireUser } from '../lib/request.ts';
import { getRepoRow, requireAccess } from '../services/repos.ts';
import { readEntry, readManifest, snapshotBelongsTo } from '../services/snapshots.ts';
import { contentDisposition, sendBlob } from './files.ts';

/**
 * 다운로드 링크와 폴더 zip.
 *
 *   POST /repos/:repoId/download-link  {path, snapshot?, archive?}  → {url, expiresAt}
 *   GET  /dl?t=<token>                                                → 파일(이어받기 가능) 또는 zip
 *
 * 토큰은 경로가 아니라 쿼리로 받는다 — 경로 파라미터는 길이 제한(100자)이 있는데 서명 토큰은
 * 한글 경로가 들어가면 수 KB 가 된다.
 *
 * 링크는 로그인 헤더 없이 받을 수 있어 브라우저가 직접 내려받는다(lib/download-links.ts).
 */
export async function registerDownloadRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;

  app.post('/repos/:repoId/download-link', async (req): Promise<DownloadLink> => {
    const user = requireUser(req);
    const { repoId } = req.params as { repoId: string };
    const { repo } = requireAccess(db, repoId, user.id, 'viewer');
    const input = body(req);
    const archive = input.archive === true;

    const snapshot = typeof input.snapshot === 'string' && input.snapshot ? input.snapshot : null;
    if (snapshot && !snapshotBelongsTo(db, snapshot, repoId)) throw notFound('스냅샷을 찾을 수 없습니다.');
    const at = snapshot ?? repo.head_snapshot_id;

    let target: string;
    if (archive) {
      const dir = normalizeDirPath(typeof input.path === 'string' ? input.path : '');
      if (dir === null) throw badRequest('경로가 올바르지 않습니다.');
      const prefix = dir === '' ? '' : `${dir}/`;
      const hasFiles = [...readManifest(db, at).keys()].some((p) => p.startsWith(prefix));
      if (!hasFiles) throw notFound('그 폴더에 파일이 없습니다.');
      target = dir;
    } else {
      const filePath = typeof input.path === 'string' ? normalizePath(input.path) : null;
      if (!filePath) throw badRequest('경로가 올바르지 않습니다.');
      if (!at || !readEntry(db, at, filePath)) throw notFound('파일을 찾을 수 없습니다.');
      target = filePath;
    }

    const epoch = db.prepare<[string], { token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = ?`).get(user.id)!;
    const { token, expiresAt } = issueDownloadLink(
      { u: user.id, ep: epoch.token_epoch, r: repoId, p: target, s: snapshot, k: archive ? 'archive' : 'file' },
      config.authSecret,
    );
    return { url: `/api/dl?t=${token}`, expiresAt };
  });

  app.get('/dl', async (req, reply) => {
    const token = (req.query as { t?: unknown }).t;
    const claims = typeof token === 'string' ? verifyDownloadLink(token, config.authSecret) : null;
    // 틀린 링크와 만료된 링크를 구분해 알려주지 않는다.
    if (!claims) throw notFound('링크가 만료됐거나 올바르지 않습니다. 다시 받아 주세요.');
    const user = db
      .prepare<[string], { token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = ?`)
      .get(claims.u);
    if (!user || user.token_epoch !== claims.ep) throw notFound('링크가 만료됐거나 올바르지 않습니다. 다시 받아 주세요.');
    // 링크를 받은 뒤 저장소에서 내보내졌다면 받을 수 없다.
    const { repo } = requireAccess(db, claims.r, claims.u, 'viewer');
    const at = claims.s ?? repo.head_snapshot_id;
    if (claims.s && !snapshotBelongsTo(db, claims.s, claims.r)) throw notFound('스냅샷을 찾을 수 없습니다.');

    if (claims.k === 'file') {
      const entry = at ? readEntry(db, at, claims.p) : undefined;
      if (!entry) throw notFound('파일을 찾을 수 없습니다.');
      return sendBlob(reply, ctx, entry.blob_hash, {
        fileName: baseName(entry.path),
        mimeType: entry.mime_type,
        size: entry.size,
        inline: false,
        cache: claims.s ? 'immutable' : 'revalidate',
      });
    }
    return sendArchive(reply, ctx, getRepoRow(db, claims.r)!.name, at, claims.p);
  });
}

/**
 * 폴더를 zip 으로 흘려보낸다. 파일 대부분이 이미 압축된 형식(사진·음악·영상·문서)이라 압축하지 않고
 * 담기만 한다 — 빠르고, 크기를 미리 알 수 있어 브라우저가 진행률을 보여 준다. 4GB 를 넘으면 ZIP64.
 * 파일 스트림은 차례가 올 때 연다(한꺼번에 수천 개를 열지 않게).
 */
async function sendArchive(
  reply: FastifyReply,
  ctx: AppContext,
  repoName: string,
  snapshotId: string | null,
  dir: string,
): Promise<FastifyReply> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = [...readManifest(ctx.db, snapshotId).values()]
    .filter((e) => e.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length === 0) throw notFound('그 폴더에 파일이 없습니다.');
  for (const entry of entries) {
    if (!(await ctx.blobs.has(entry.blob_hash))) throw notFound(`파일 데이터를 찾을 수 없습니다: ${entry.path}`);
  }

  // zip 안에서는 폴더 이름(저장소 전체면 저장소 이름)을 맨 위 폴더로 둔다 — 풀었을 때 흩어지지 않게.
  const rootName = (dir === '' ? repoName : baseName(dir)).replace(/[\\/:*?"<>|]/g, '_') || 'listup';
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    const inner = `${rootName}/${entry.path.slice(prefix.length)}`;
    zip.addReadStreamLazy(
      inner,
      { size: entry.size, compress: false, mtime: new Date(entry.updated_at) },
      (cb) => cb(null, ctx.blobs.createReadStream(entry.blob_hash)),
    );
  }

  const output = new PassThrough();
  zip.outputStream.pipe(output);
  zip.outputStream.on('error', (err) => output.destroy(err as Error));
  let totalSize = -1;
  zip.end({ forceZip64Format: false, comment: '' }, ((size: number) => {
    totalSize = size;
  }) as unknown as () => void);

  reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', contentDisposition(`${rootName}.zip`, false))
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff');
  // 모든 크기를 알고 압축하지 않으므로 yazl 이 끝나기 전에 전체 크기를 계산해 준다.
  if (totalSize >= 0) reply.header('Content-Length', String(totalSize));
  if (reply.request.method === 'HEAD') {
    output.destroy();
    return reply.send('');
  }
  return reply.send(output);
}
