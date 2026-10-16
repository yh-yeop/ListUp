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

type Migration = (typeof MIGRATIONS)[number];

/**
 * 밀린 마이그레이션을 차례로 적용한다. 하나씩 트랜잭션으로 묶고, 실패하면 그 하나를 되돌린다.
 *
 * 마이그레이션 동안에는 외래 키 검사를 끈다 — 켜 둔 채로는 표를 새로 만들어 옮기는 변경(이름 바꾸기·
 * 제약 바꾸기)에서 옛 표를 지울 때 자식 행이 함께 지워지거나(ON DELETE CASCADE) 막힌다. 대신 커밋 전에
 * `PRAGMA foreign_key_check` 로 어긋난 참조가 없는지 보고, 있으면 되돌린다. 끝나면 다시 켠다.
 * (`foreign_keys` 는 트랜잭션 안에서 바꿀 수 없어 밖에서 끄고 켠다.)
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations.filter((migration) => migration.version > current);
  if (pending.length === 0) return;

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  let vacuum = false;
  try {
    for (const migration of pending) {
      db.exec('BEGIN');
      try {
        if (migration.up) db.exec(migration.up);
        migration.run?.(db);
        const broken = db.pragma('foreign_key_check') as { table: string; parent: string }[];
        if (broken.length > 0) {
          const where = [...new Set(broken.map((row) => `${row.table} → ${row.parent}`))].join(', ');
          throw new Error(`마이그레이션 v${migration.version} 뒤 어긋난 외래 키 ${broken.length}건: ${where}`);
        }
        // user_version 은 바인딩 파라미터를 받지 않는다. 값은 코드 상수라 안전.
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      vacuum ||= migration.vacuum === true;
    }
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON');
  }
  // VACUUM 은 트랜잭션 밖에서만 된다. 새 DB 에는 치울 것이 없으니 옛 DB 를 올릴 때만.
  if (vacuum && current > 0) db.exec('VACUUM');
}
