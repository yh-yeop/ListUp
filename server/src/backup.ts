/**
 * DB 백업. WAL 모드라 listup.db 를 그냥 복사하면 -wal 파일에만 있는 최근 변경이 빠지므로,
 * better-sqlite3 의 온라인 백업 API 로 일관된 사본을 만든다.
 *
 *   npm run backup -- <대상 디렉터리>      (생략하면 <DB 디렉터리>/backups)
 *
 * blob 은 내용 주소라 덮어쓰기가 없으므로 blobs 디렉터리는 따로 그냥 복사하면 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './config.ts';

/** 파일명에 쓰는 로컬 시각: YYYYMMDD-HHmmss */
function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const config = loadConfig();
if (config.dbPath === ':memory:') {
  console.error('인메모리 DB 는 백업할 수 없습니다.');
  process.exit(1);
}
if (!fs.existsSync(config.dbPath)) {
  console.error(`DB 파일이 없습니다: ${config.dbPath}`);
  process.exit(1);
}

// npm run 은 워크스페이스 디렉터리(server/)에서 실행되므로,
// 상대 경로는 명령을 친 위치(INIT_CWD) 기준으로 푼다.
const base = process.env.INIT_CWD ?? process.cwd();
const destDir = process.argv[2]
  ? path.resolve(base, process.argv[2])
  : path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, `listup-${timestamp(new Date())}.db`);

const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}

console.log(`DB 백업 완료: ${dest}`);
console.log(`blobs 디렉터리는 이 명령이 복사하지 않습니다. 따로 복사하세요: ${config.blobDir}`);
