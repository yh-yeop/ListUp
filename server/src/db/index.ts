import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.sql.ts';

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  let vacuum = false;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      if (migration.up) db.exec(migration.up);
      migration.run?.(db);
      // user_version 은 바인딩 파라미터를 받지 않는다. 값은 코드 상수라 안전.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    vacuum ||= migration.vacuum === true;
  }
  // VACUUM 은 트랜잭션 밖에서만 된다. 새 DB 에는 치울 것이 없으니 옛 DB 를 올릴 때만.
  if (vacuum && current > 0) db.exec('VACUUM');
}
