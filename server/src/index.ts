import type { FastifyRequest } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { scheduleGc } from './services/gc.ts';

const config = loadConfig();
const ctx = createContext(config);

/** 초대 코드는 URL 경로에 실려 오므로 로그에 남기지 않는다. */
function maskUrl(url: string): string {
  return url.replace(/\/api\/invites\/[^/?#]+/, '/api/invites/***');
}

const app = await buildApp(ctx, {
  logger: {
    level: config.logLevel,
    serializers: {
      // fastify 기본 직렬화와 같은 모양에서 url 만 가린다.
      req(req: FastifyRequest) {
        return {
          method: req.method,
          url: maskUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket ? req.socket.remotePort : undefined,
        };
      },
    },
  },
});

// 어디에서도 참조하지 않는 blob 을 주기적으로 지운다 (제안에 담기 전에 버려진 업로드 등).
const stopGc = scheduleGc(
  ctx,
  (result) => {
    if (result.removed > 0 || result.orphanFiles > 0 || result.failed > 0) {
      app.log.info(result, 'blob GC');
    }
  },
  (err) => app.log.error({ err }, 'blob GC 실패'),
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // 연결이 안 닫혀 close 가 끝나지 않아도 10초 뒤에는 강제로 끝낸다. 타이머가 종료를 붙들지 않게 unref.
  setTimeout(() => process.exit(1), 10_000).unref();
  stopGc();
  await app.close();
  ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// 처리되지 않은 프로미스 거부는 프로세스를 죽이는 대신 로그로 남긴다.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { db: config.dbPath, blobs: config.blobDir },
    `ListUp 서버가 http://${config.host}:${config.port} 에서 실행 중입니다.`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
