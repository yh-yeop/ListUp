import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from './app.ts';
import type { Config } from './config.ts';
import { createContext, type AppContext } from './context.ts';
import { scheduleGc } from './services/gc.ts';

export interface RunningServer {
  app: FastifyInstance;
  ctx: AppContext;
  /** 요청을 마저 끝내고 GC·DB 까지 닫는다. 여러 번 불러도 한 번만 닫는다. */
  stop(): Promise<void>;
}

/**
 * 로그에 남기면 안 되는 URL 조각을 가린다 — 초대 코드(경로)와 다운로드 링크 토큰(`/api/dl?t=`).
 * 다운로드 토큰은 로그인 없이 파일을 받을 수 있는 서명이라, PC 앱이 로그를 파일로 남기면 디스크에 쌓인다.
 */
export function maskUrl(url: string): string {
  return url.replace(/\/api\/invites\/[^/?#]+/, '/api/invites/***').replace(/([?&]t=)[^&#]+/g, '$1***');
}

/** fastify 기본 직렬화와 같은 모양에서 url 만 가린다. */
export const logSerializers = {
  req(req: FastifyRequest) {
    return {
      method: req.method,
      url: maskUrl(req.url),
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket ? req.socket.remotePort : undefined,
    };
  },
};

/**
 * 서버를 켠다 — 명령줄 서버(index.ts)와 PC 앱이 함께 쓴다.
 * 포트를 열지 못하면 DB 를 닫고 오류를 던진다.
 */
export async function startServer(config: Config): Promise<RunningServer> {
  const ctx = createContext(config);

  const app = await buildApp(ctx, {
    logger: {
      level: config.logLevel,
      serializers: logSerializers,
    },
  });

  // 어디에서도 참조하지 않는 blob 을 주기적으로 지운다 (제안에 담기 전에 버려진 업로드 등).
  const stopGc = scheduleGc(
    ctx,
    (result) => {
      if (result.removed > 0 || result.orphanFiles > 0 || result.failed > 0 || result.staleUploads > 0) {
        app.log.info(result, 'blob GC');
      }
    },
    (err) => app.log.error({ err }, 'blob GC 실패'),
  );

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      stopGc();
      await app.close();
      ctx.close();
    })();
    return stopping;
  };

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    await stop();
    throw err;
  }
  app.log.info(
    { db: config.dbPath, blobs: config.blobDir },
    `ListUp 서버가 http://${config.host}:${config.port} 에서 실행 중입니다.`,
  );
  return { app, ctx, stop };
}
