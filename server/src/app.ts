import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@listup/shared';
import type { AppContext } from './context.ts';
import { ApiError } from './lib/errors.ts';
import { verifyToken } from './lib/auth.ts';
import type { AuthUser } from './lib/request.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerRepoRoutes } from './routes/repos.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerProposalRoutes } from './routes/proposals.ts';

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(ctx: AppContext, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024, // JSON 본문은 작다. 파일은 multipart 로 따로 제한.
  });

  await app.register(cors, {
    origin: ctx.config.corsOrigin === '*' ? true : ctx.config.corsOrigin.split(','),
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });

  await app.register(multipart, {
    limits: {
      fileSize: ctx.config.maxUploadBytes,
      files: 1,
      fields: 10,
    },
  });

  // ---------------------------------------------------------------------
  // 인증: 토큰이 있으면 사용자로 해석하고, 없으면 그냥 통과시킨다.
  // 실제 권한 검사는 각 라우트에서 requireUser 로 한다.
  // ---------------------------------------------------------------------
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return;
    const userId = verifyToken(header.slice(7).trim(), ctx.config.authSecret);
    if (!userId) return;
    const row = ctx.db
      .prepare<[string], { id: string; email: string; display_name: string }>(
        `SELECT id, email, display_name FROM users WHERE id = ?`,
      )
      .get(userId);
    if (!row) return;
    const user: AuthUser = { id: row.id, email: row.email, displayName: row.display_name };
    req.user = user;
  });

  // ---------------------------------------------------------------------
  // 에러 응답 통일
  // ---------------------------------------------------------------------
  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (error instanceof ApiError) {
      const payload: ApiErrorBody = {
        error: { code: error.code, message: error.message, details: error.details },
      };
      return reply.code(error.statusCode).send(payload);
    }

    // multipart 등 fastify 계열 에러 매핑
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: {
          code: 'payload_too_large',
          message: `파일이 너무 큽니다. 최대 ${Math.floor(ctx.config.maxUploadBytes / 1024 / 1024)}MB.`,
        },
      } satisfies ApiErrorBody);
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: 'bad_request', message: error.message },
      } satisfies ApiErrorBody);
    }

    req.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal', message: '서버 오류가 발생했습니다.' },
    } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: '요청한 경로가 없습니다.' },
    } satisfies ApiErrorBody),
  );

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  await app.register(async (api) => {
    await registerAuthRoutes(api, ctx);
    await registerRepoRoutes(api, ctx);
    await registerFileRoutes(api, ctx);
    await registerInviteRoutes(api, ctx);
    await registerProposalRoutes(api, ctx);
  }, { prefix: '/api' });

  return app;
}
