/**
 * PC 앱이 utilityProcess 로 띄우는 서버. 앱 본체(main)와 메시지로 이야기한다.
 *
 *   argv[2] = 'serve'  서버를 켜고, 멈추라는 말이 올 때까지 돈다
 *   argv[2] = 'task'   포트를 열지 않고 DB 만 열어 일(백업 등) 하나를 하고 끝난다
 *
 * 설정은 명령줄 서버와 같은 LISTUP_* 환경변수로 받는다(main 이 채워 준다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/src/config.ts';
import { openDb, type Db } from '../../server/src/db/index.ts';
import { normalizeEmail } from '../../server/src/lib/auth.ts';
import { issueResetCode } from '../../server/src/services/password-reset.ts';
import { startServer, type RunningServer } from '../../server/src/start.ts';
import type { ServerRequest, ServerReply } from './protocol.ts';

// utilityProcess 안에서만 있는 통로.
const port = (process as unknown as { parentPort: Electron.ParentPort }).parentPort;
const send = (message: ServerReply) => port.postMessage(message);

const mode = process.argv[2] === 'task' ? 'task' : 'serve';
const config = loadConfig();

let server: RunningServer | null = null;
let taskDb: Db | null = null;

function db(): Db {
  if (server) return server.ctx.db;
  taskDb ??= openDb(config.dbPath);
  return taskDb;
}

/** 파일명에 쓰는 로컬 시각: YYYYMMDD-HHmmss */
function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * DB 는 온라인 백업 API 로(WAL 이라 파일 복사로는 최근 변경이 빠진다), blob 은 그대로 복사한다.
 * blob 은 내용 주소라 이름이 같으면 내용도 같다 — 같은 폴더에 다시 담으면 새 파일만 복사된다.
 */
async function backup(dir: string): Promise<string> {
  const dest = path.join(dir, `listup-${timestamp(new Date())}.db`);
  fs.mkdirSync(dir, { recursive: true });
  await db().backup(dest);
  if (fs.existsSync(config.blobDir)) {
    fs.cpSync(config.blobDir, path.join(dir, 'blobs'), {
      recursive: true,
      force: false,
      errorOnExist: false,
      // tmp 는 올리는 중인 조각이다.
      filter: (src) => path.relative(config.blobDir, src).split(path.sep)[0] !== 'tmp',
    });
  }
  return dest;
}

async function handle(request: ServerRequest): Promise<unknown> {
  switch (request.type) {
    case 'reset-code': {
      const email = normalizeEmail(request.email);
      if (!email) throw new Error('이메일 형식이 올바르지 않습니다.');
      return issueResetCode(db(), email);
    }
    case 'backup':
      return backup(request.dir);
    case 'stop':
      await shutdown();
      return null;
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // 연결이 안 닫혀 close 가 끝나지 않아도 10초 뒤에는 끝낸다.
  setTimeout(() => process.exit(1), 10_000).unref();
  await server?.stop();
  taskDb?.close();
  send({ type: 'stopped' });
  process.exit(0);
}

port.on('message', (event) => {
  const request = event.data as ServerRequest;
  handle(request).then(
    (value) => send({ type: 'result', id: request.id, ok: true, value }),
    (err: unknown) =>
      send({ type: 'result', id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

process.on('unhandledRejection', (reason) => {
  server?.app.log.error({ err: reason }, 'unhandled rejection');
});

if (mode === 'serve') {
  try {
    server = await startServer(config);
    send({ type: 'ready' });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    send({
      type: 'failed',
      code: typeof code === 'string' ? code : null,
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
} else {
  send({ type: 'ready' });
}
