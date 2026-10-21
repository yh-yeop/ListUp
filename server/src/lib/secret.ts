import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 데이터 폴더 안의 서명 키 파일 이름. */
export const AUTH_SECRET_FILE = 'auth-secret.txt';

/** 만들어 둔 키의 형식 — randomBytes(32) 의 hex. */
const SECRET_FORMAT = /^[0-9a-f]{64}$/i;

/**
 * 데이터 폴더의 서명 키 — 있으면 읽고, 없으면 만든다. `npm run serve`(scripts/serve.mjs)와 PC 앱(desktop/src/host.ts)이 쓴다.
 *
 * 키가 바뀌면 전원 로그아웃되므로, 파일이 있는데 형식이 틀리면(쓰다 잘렸거나 누가 고쳤다) 새로 만들지 않고 멈춘다.
 * 새로 만들 때는 임시 파일에 쓰고 fsync 한 뒤 이름을 바꿔, 쓰다 죽어도 반쯤 쓴 키가 남지 않는다.
 * 권한은 가능하면 0600 (Windows 는 무시된다).
 */
export function ensureAuthSecret(dataDir: string): { secret: string; file: string; created: boolean } {
  const file = path.join(dataDir, AUTH_SECRET_FILE);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text !== null) {
    const secret = text.trim();
    if (!SECRET_FORMAT.test(secret)) {
      throw new Error(
        `서명 키 파일이 올바르지 않습니다 (64자 16진수가 아님): ${file}\n` +
          '  키가 바뀌면 모두 로그아웃되므로 새로 만들지 않았습니다. 백업에서 이 파일을 되살리거나, ' +
          '모두 다시 로그인해도 된다면 파일을 지우고 다시 켜세요.',
      );
    }
    return { secret, file, created: false };
  }

  const secret = randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${secret}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { secret, file, created: true };
}
