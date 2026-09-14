import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.ts';
import { MIGRATIONS } from '../src/db/schema.sql.ts';
import { blobBelongsToRepo } from '../src/services/proposals.ts';
import { listSnapshots, readManifest, snapshotStats } from '../src/services/snapshots.ts';

/** version 까지만 적용된 DB 파일을 만든다. */
function createDbAt(dbPath: string, version: number, options: { foreignKeys: boolean }): Database.Database {
  const db = new Database(dbPath);
  db.pragma(`foreign_keys = ${options.foreignKeys ? 'ON' : 'OFF'}`);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) continue;
    if (migration.up) db.exec(migration.up);
    migration.run?.(db);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-mig-'));
  try {
    fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 윈도우에서 sqlite 파일 핸들이 늦게 풀리면 임시 디렉터리 정리가 실패할 수 있다.
    }
  }
}

describe('마이그레이션 v3 (경로 재정규화)', () => {
  it('예전 규칙으로 저장된 경로를 새 normalizePath 규칙으로 재작성한다', () => {
    withTempDir((dir) => {
      // 테스트 픽스처는 부모 행(users/repos/snapshots/blobs) 없이 항목만 넣는다.
      const db = createDbAt(path.join(dir, 'test.db'), 2, { foreignKeys: false });
      try {
        const now = Date.now();
        const insertEntry = db.prepare(
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
        db.prepare(
          `INSERT INTO proposal_changes (proposal_id, path, op, blob_hash, size) VALUES (?, ?, 'add', ?, 1)`,
        ).run('p1', nfdPath, 'h1');

        // v3 만 적용한다 — 뒤의 마이그레이션(v5 는 snapshot_entries 를 없앤다)과 무관하게 확인하려고.
        MIGRATIONS.find((m) => m.version === 3)!.run!(db);

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
    });
  });
});

describe('마이그레이션 v5 (스냅샷을 바뀐 것만 기록)', () => {
  it('이전 뒤에도 모든 스냅샷의 파일 목록이 이전 전과 똑같다', () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, 'test.db');
      const old = createDbAt(dbPath, 4, { foreignKeys: true });

      type Entry = { path: string; blob_hash: string; size: number; mime_type: string; updated_at: number };
      const expected = new Map<string, Entry[]>();
      const snapshotIds: string[] = [];

      old.prepare(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ('u1', 'a@a.a', 'x', 'a', 0)`).run();
      old.prepare(`INSERT INTO repos (id, name, owner_id, created_at, updated_at) VALUES ('r1', 'repo', 'u1', 0, 0)`).run();
      for (const hash of ['h1', 'h2', 'h3', 'h4']) {
        old.prepare(`INSERT INTO blobs (hash, size, mime_type, created_at) VALUES (?, ?, 'text/plain', 0)`).run(hash, hash.length * 10);
      }

      // 옛 구조로 커밋을 흉내 낸다 — 커밋마다 전체 목록을 복사한다.
      let manifest: Entry[] = [];
      let parent: string | null = null;
      let clock = 1000;
      const commit = (next: Entry[]) => {
        clock += 1;
        const id = `s${snapshotIds.length + 1}`;
        old.prepare(
          `INSERT INTO snapshots (id, repo_id, parent_id, message, author_id, created_at) VALUES (?, 'r1', ?, '', 'u1', ?)`,
        ).run(id, parent, clock);
        for (const e of next) {
          old.prepare(
            `INSERT INTO snapshot_entries (snapshot_id, path, blob_hash, size, mime_type, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, e.path, e.blob_hash, e.size, e.mime_type, e.updated_at);
        }
        old.prepare(`UPDATE repos SET head_snapshot_id = ? WHERE id = 'r1'`).run(id);
        expected.set(id, next.map((e) => ({ ...e })));
        snapshotIds.push(id);
        parent = id;
        manifest = next;
      };
      const file = (p: string, hash: string, at: number, mime = 'text/plain'): Entry => ({
        path: p, blob_hash: hash, size: hash.length * 10, mime_type: mime, updated_at: at,
      });

      commit([file('a.txt', 'h1', 1)]); // 추가
      commit([...manifest, file('dir/b.txt', 'h2', 2)]); // 추가
      commit(manifest.map((e) => (e.path === 'a.txt' ? file('a.txt', 'h3', 3) : e))); // 수정
      commit(manifest.filter((e) => e.path !== 'dir/b.txt')); // 삭제
      commit([...manifest.filter((e) => e.path !== 'a.txt'), file('moved/a.txt', 'h3', 5)]); // 이동
      commit(manifest.map((e) => ({ ...e, mime_type: 'text/markdown' }))); // 해시는 같고 속성만 바뀜
      commit([...manifest, file('a.txt', 'h1', 7)]); // 지웠던 경로에 옛 내용이 되돌아옴
      commit([]); // 전부 삭제
      commit([file('c.txt', 'h4', 9)]); // 빈 뒤에 다시 추가
      old.close();

      const db = openDb(dbPath);
      try {
        const latest = Math.max(...MIGRATIONS.map((m) => m.version));
        assert.equal(db.pragma('user_version', { simple: true }), latest);
        const hasOldTable = db
          .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_entries'`)
          .get();
        assert.equal(hasOldTable, undefined, '옛 표는 지운다');

        const sort = (rows: Entry[]) => [...rows].sort((a, b) => a.path.localeCompare(b.path));
        for (const id of snapshotIds) {
          const actual = sort([...readManifest(db, id).values()]);
          assert.deepEqual(actual, sort(expected.get(id)!), `스냅샷 ${id} 의 목록`);
          const want = expected.get(id)!;
          assert.deepEqual(snapshotStats(db, id), {
            fileCount: want.length,
            totalSize: want.reduce((sum, e) => sum + e.size, 0),
          });
        }

        // 지금 목록은 head 그대로이고, 이력 목록에도 파일 수가 나온다.
        const head = db.prepare(`SELECT path, blob_hash FROM repo_files WHERE repo_id = 'r1'`).all();
        assert.deepEqual(head, [{ path: 'c.txt', blob_hash: 'h4' }]);
        const history = listSnapshots(db, 'r1', 100);
        assert.equal(history.length, snapshotIds.length);
        assert.equal(history.find((s) => s.id === 's2')?.fileCount, 2);

        // 지금은 없지만 이력에 있던 파일은 이 저장소의 것으로 친다 (지운 파일을 되살리는 제안).
        assert.equal(blobBelongsToRepo(db, 'r1', 'h2'), true);
        assert.equal(blobBelongsToRepo(db, 'r1', 'nope'), false);

        // 바뀐 것만 적었다 — 커밋마다 전체를 복사했다면 행이 훨씬 많다.
        const changeRows = (db.prepare(`SELECT COUNT(*) AS n FROM snapshot_changes`).get() as { n: number }).n;
        assert.equal(changeRows, 1 + 1 + 1 + 1 + 2 + 1 + 1 + 2 + 1);
      } finally {
        db.close();
      }
    });
  });
});
