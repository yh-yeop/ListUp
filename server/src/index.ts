import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadConfig();
const ctx = createContext(config);
const app = await buildApp(ctx, { logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

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
