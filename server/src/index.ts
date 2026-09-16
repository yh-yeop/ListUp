/*
 * ListUp — 초대 코드로 참여하는 파일 공유 협업 플랫폼
 * Copyright (C) 2026 yh-yeop
 *
 * 이 프로그램은 자유 소프트웨어입니다. Free Software Foundation 이 펴낸 GNU Affero
 * General Public License 버전 3 의 조건에 따라 재배포하거나 고칠 수 있습니다.
 *
 * 이 프로그램은 쓸모가 있기를 바라며 배포하지만 아무런 보증도 하지 않습니다.
 * 자세한 내용은 GNU Affero General Public License 를 보세요.
 * 사본은 함께 있는 LICENSE 파일 또는 <https://www.gnu.org/licenses/> 에 있습니다.
 */
import { loadConfig } from './config.ts';
import { startServer } from './start.ts';

const config = loadConfig();

let server;
try {
  server = await startServer(config);
} catch (err) {
  console.error(err);
  process.exit(1);
}
const { app } = server;

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // 연결이 안 닫혀 close 가 끝나지 않아도 10초 뒤에는 강제로 끝낸다. 타이머가 종료를 붙들지 않게 unref.
  setTimeout(() => process.exit(1), 10_000).unref();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// 처리되지 않은 프로미스 거부는 프로세스를 죽이는 대신 로그로 남긴다.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
});
