import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.ts';
import { MIGRATIONS } from '../src/db/schema.sql.ts';

/** 버전 2까지만 적용된 DB 파일을 만든다 — 경로 정규화가 강화되기 전 상태. */
function createV2Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  // 테스트 픽스처는 부모 행(users/repos/snapshots/blobs) 없이 항목만 넣는다.
  db.pragma('foreign_keys = OFF');
  for (const migration of MIGRATIONS) {
    if (migration.version > 2) continue;
    if (migration.up) db.exec(migration.up);
  }
  db.exec('PRAGMA user_version = 2');
  return db;
}

describe('마이그레이션 v3 (경로 재정규화)', () => {
  it('예전 규칙으로 저장된 경로를 새 normalizePath 규칙으로 재작성한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-mig-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      const old = createV2Db(dbPath);
      const now = Date.now();
      const insertEntry = old.prepare(
        `INSERT INTO snapshot_entries (snapshot_id, path, blob_hash, size, mime_type, updated_at)
         VALUES (?, ?, ?, ?, 'text/plain', ?)`,
      );
      // macOS 브라우저가 올린 NFD 한글 파일명과, 이름 앞에 공백이 있는 경로.
      const nfdPath = '한글 파일.txt'.normalize('NFD');
      insertEntry.run('s1', nfdPath, 'h1', 1, now);
      insertEntry.run('s1', 'docs/ 공백.txt', 'h2', 1, now);
      // 정규화 결과가 기존 행과 겹치는 경우 — 그대로 남아야 한다.
      insertEntry.run('s1', 'a.txt', 'h3', 1, now);
      insertEntry.run('s1', 'a.txt ', 'h4', 1, now);
      old
        .prepare(
          `INSERT INTO proposal_changes (proposal_id, path, op, blob_hash, size) VALUES (?, ?, 'add', ?, 1)`,
        )
        .run('p1', nfdPath, 'h1');
      old.close();

      const db = openDb(dbPath); // 남은 마이그레이션이 여기서 적용된다.
      try {
        // 마이그레이션을 더 붙여도 깨지지 않게 최신 버전과 비교한다.
        const latest = Math.max(...MIGRATIONS.map((m) => m.version));
        assert.equal(db.pragma('user_version', { simple: true }), latest);
        const entryPaths = db
          .prepare(`SELECT path FROM snapshot_entries WHERE snapshot_id = 's1' ORDER BY blob_hash`)
          .all() as { path: string }[];
        assert.deepEqual(
          entryPaths.map((row) => row.path),
          ['한글 파일.txt'.normalize('NFC'), 'docs/공백.txt', 'a.txt', 'a.txt '],
        );
        const changePath = db
          .prepare(`SELECT path FROM proposal_changes WHERE proposal_id = 'p1'`)
          .get() as { path: string };
        assert.equal(changePath.path, '한글 파일.txt'.normalize('NFC'));
      } finally {
        db.close();
      }
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 윈도우에서 sqlite 파일 핸들이 늦게 풀리면 임시 디렉터리 정리가 실패할 수 있다.
      }
    }
  });
});
