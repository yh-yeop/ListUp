import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
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
  logger?: boolean | FastifyServerOptions['logger'];
}

/** 경로 어딘가에 `.` 으로 시작하는 이름(.env, .git/…)이 있으면 웹 앱 라우트로 보지 않는다. */
function hasDotSegment(url: string): boolean {
  const pathname = url.split('?')[0];
  return pathname.split('/').some((segment) => segment.startsWith('.'));
}

export async function buildApp(ctx: AppContext, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 1024 * 1024, // JSON 본문은 작다. 파일은 multipart 로 따로 제한.
  });

  const corsOrigins = ctx.config.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  await app.register(cors, {
    // 인증은 Bearer 헤더로만 하므로 쿠키용 credentials 는 열지 않는다.
    origin: ctx.config.corsOrigin.trim() === '*' ? true : corsOrigins,
    exposedHeaders: ['Content-Disposition'],
  });

  await app.register(multipart, {
    limits: {
      fileSize: ctx.config.maxUploadBytes,
      files: 1,
      fields: 10,
    },
  });

  // 웹 응답(정적 파일·SPA 폴백)에 붙는 브라우저 보호 헤더.
  // 훅은 등록된 뒤에 만들어지는 라우트에만 붙으므로 정적 서빙보다 먼저 건다.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) return;
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
  });

  // ---------------------------------------------------------------------
  // 웹 정적 빌드 서빙: 빌드 결과물이 있으면 API 와 같은 오리진에서 함께 서빙한다.
  // EXPO_PUBLIC_LISTUP_API_URL=/ 로 빌드한 웹 번들은 상대 경로로 API 를 부르므로
  // 도메인이 무엇이든 재빌드 없이 동작한다.
  // ---------------------------------------------------------------------
  const webRoot = ctx.config.webDir;
  const serveWeb = webRoot !== null && existsSync(path.join(webRoot, 'index.html'));
  if (serveWeb) {
    const staticRoot: string = webRoot;
    await app.register(fastifyStatic, {
      root: staticRoot,
      // .env 같은 숨김 파일은 없는 것처럼 다룬다.
      dotfiles: 'ignore',
      // send 가 붙이는 Cache-Control 이 setHeaders 값을 덮어쓰므로 끄고, 아래에서 경로별로 정한다.
      cacheControl: false,
      setHeaders(res, filePath) {
        const relative = path.relative(staticRoot, filePath).split(path.sep).join('/');
        let cache = 'public, max-age=0';
        if (relative.startsWith('_expo/')) {
          // Expo 웹 번들은 파일명에 해시가 들어가므로 영원히 캐시해도 된다.
          cache = 'public, max-age=31536000, immutable';
        } else if (relative === 'index.html') {
          // 번들 이름이 바뀌면 index.html 이 새로 내려가야 하므로 매번 재검증한다.
          cache = 'no-cache';
        }
        res.setHeader('Cache-Control', cache);
      },
    });
  }

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
        error: {
          // JSON 본문 한도 초과(413) 도 앱이 용량 문제로 구분할 수 있게 한다.
          code: error.statusCode === 413 ? 'payload_too_large' : 'bad_request',
          message: error.message,
        },
      } satisfies ApiErrorBody);
    }

    req.log.error({ err: error }, 'unhandled error');
    // requestId 는 로그의 reqId 와 같다 — 사용자가 알려주면 로그에서 바로 찾을 수 있다.
    const payload: ApiErrorBody & { requestId: string } = {
      error: { code: 'internal', message: '서버 오류가 발생했습니다.' },
      requestId: req.id,
    };
    return reply.code(500).send(payload);
  });

  app.setNotFoundHandler((req, reply) => {
    // SPA 라우팅: /api 밖의 GET 은 웹 앱(index.html)이 처리하게 넘긴다.
    // 숨김 파일 경로(/.env 등)는 정적 서빙이 무시한 것이므로 앱으로 넘기지 않고 404 다.
    if (
      serveWeb &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api/') &&
      !hasDotSegment(req.url)
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'not_found', message: '요청한 경로가 없습니다.' },
    } satisfies ApiErrorBody);
  });

  app.get('/api/health', async () => ({
    ok: true,
    time: Date.now(),
    // 앱이 업로드 사전 검사에 쓰는 값. 서버 설정(LISTUP_MAX_UPLOAD_MB)을 따른다.
    maxUploadBytes: ctx.config.maxUploadBytes,
  }));

  await app.register(async (api) => {
    await registerAuthRoutes(api, ctx);
    await registerRepoRoutes(api, ctx);
    await registerFileRoutes(api, ctx);
    await registerInviteRoutes(api, ctx);
    await registerProposalRoutes(api, ctx);
  }, { prefix: '/api' });

  return app;
}
