import type Database from 'better-sqlite3';
import { normalizePath } from '@listup/shared';

/**
 * 스키마 정의. 단일 마이그레이션으로 시작하고, 이후 변경은 MIGRATIONS 배열에
 * 항목을 덧붙이는 방식으로 관리한다 (user_version 으로 적용 여부 추적).
 * SQL 만으로 어려운 데이터 변환은 run 으로 쓴다 — up 과 같은 트랜잭션 안에서 실행된다.
 */
export const MIGRATIONS: {
  version: number;
  up?: string;
  run?: (db: Database.Database) => void;
  /** 큰 표를 지워 파일에 빈 공간이 많이 남는 마이그레이션. 적용 뒤 한 번 VACUUM 한다. */
  vacuum?: boolean;
}[] = [
  {
    version: 1,
    up: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE repos (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        owner_id         TEXT NOT NULL REFERENCES users(id),
        head_snapshot_id TEXT,
        proposal_seq     INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_repos_owner ON repos(owner_id);

      CREATE TABLE repo_members (
        repo_id   TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      TEXT NOT NULL CHECK (role IN ('viewer','editor','owner')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, user_id)
      );
      CREATE INDEX idx_members_user ON repo_members(user_id);

      -- 콘텐츠 주소 저장. 같은 내용은 저장소가 달라도 한 번만 보관한다.
      CREATE TABLE blobs (
        hash       TEXT PRIMARY KEY,
        size       INTEGER NOT NULL,
        mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
        created_at INTEGER NOT NULL
      );

      -- 스냅샷 = 특정 시점의 전체 파일 목록 (커밋).
      CREATE TABLE snapshots (
        id         TEXT PRIMARY KEY,
        repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        parent_id  TEXT REFERENCES snapshots(id),
        message    TEXT NOT NULL DEFAULT '',
        author_id  TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_snapshots_repo ON snapshots(repo_id, created_at DESC);

      CREATE TABLE snapshot_entries (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        path        TEXT NOT NULL,
        blob_hash   TEXT NOT NULL REFERENCES blobs(hash),
        size        INTEGER NOT NULL,
        mime_type   TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      );

      CREATE TABLE invites (
        id         TEXT PRIMARY KEY,
        repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        code       TEXT NOT NULL UNIQUE,
        role       TEXT NOT NULL CHECK (role IN ('viewer','editor')),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_uses   INTEGER,
        use_count  INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER
      );
      CREATE INDEX idx_invites_repo ON invites(repo_id, created_at DESC);

      CREATE TABLE proposals (
        id                 TEXT PRIMARY KEY,
        repo_id            TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number             INTEGER NOT NULL,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL CHECK (status IN ('open','merged','closed')),
        author_id          TEXT NOT NULL REFERENCES users(id),
        base_snapshot_id   TEXT REFERENCES snapshots(id),
        merged_snapshot_id TEXT REFERENCES snapshots(id),
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        UNIQUE (repo_id, number)
      );
      CREATE INDEX idx_proposals_repo ON proposals(repo_id, status, created_at DESC);

      CREATE TABLE proposal_changes (
        proposal_id    TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        path           TEXT NOT NULL,
        op             TEXT NOT NULL CHECK (op IN ('add','update','delete')),
        blob_hash      TEXT REFERENCES blobs(hash),
        size           INTEGER NOT NULL DEFAULT 0,
        mime_type      TEXT,
        base_blob_hash TEXT,
        base_size      INTEGER,
        PRIMARY KEY (proposal_id, path)
      );

      CREATE TABLE proposal_comments (
        id          TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        author_id   TEXT NOT NULL REFERENCES users(id),
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_comments_proposal ON proposal_comments(proposal_id, created_at);
    `,
  },
  {
    version: 2,
    up: `
      -- 어느 저장소로 올라온 blob 인지 기록한다. blob 은 전역 콘텐츠 주소라 해시만 알면
      -- 남의 저장소 파일을 제안에 끼워 넣어 읽을 수 있었는데, 이 표로 "이 저장소에 올린 것"만 허용한다.
      -- 사용자별 일일 업로드 한도 계산에도 쓴다.
      CREATE TABLE repo_blobs (
        repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        hash        TEXT NOT NULL REFERENCES blobs(hash),
        uploaded_by TEXT NOT NULL REFERENCES users(id),
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (repo_id, hash)
      );
      CREATE INDEX idx_repo_blobs_user ON repo_blobs(uploaded_by, created_at);

      -- 외래키 자식 컬럼 인덱스. 없으면 부모 행을 지우거나 참조를 찾을 때 전체 스캔을 한다.
      CREATE INDEX idx_entries_blob ON snapshot_entries(blob_hash);
      CREATE INDEX idx_snapshots_parent ON snapshots(parent_id);
      CREATE INDEX idx_proposals_base ON proposals(base_snapshot_id);
      CREATE INDEX idx_proposals_merged ON proposals(merged_snapshot_id);
      CREATE INDEX idx_changes_blob ON proposal_changes(blob_hash);
      CREATE INDEX idx_invites_creator ON invites(created_by);
    `,
  },
  {
    // normalizePath 규칙이 강화되어(NFC 통일, 이름 앞뒤 공백 제거) 예전 규칙으로 저장된
    // 경로는 정규화된 요청 경로와 정확 일치하지 않아 내려받기·삭제·이동이 전부 404 가 된다.
    // 기존 행을 새 규칙으로 재작성해 계속 접근할 수 있게 한다.
    version: 3,
    run(db) {
      const targets = [
        { table: 'snapshot_entries', key: 'snapshot_id' },
        { table: 'proposal_changes', key: 'proposal_id' },
      ] as const;
      for (const { table, key } of targets) {
        const rows = db
          .prepare(`SELECT ${key} AS id, path FROM ${table}`)
          .all() as { id: string; path: string }[];
        const exists = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE ${key} = ? AND path = ?`);
        const update = db.prepare(`UPDATE ${table} SET path = ? WHERE ${key} = ? AND path = ?`);
        for (const row of rows) {
          const normalized = normalizePath(row.path);
          if (normalized === row.path) continue;
          // 새 규칙으로도 유효하지 않거나(포맷 문자 등) 같은 스냅샷/제안의 다른 행과 겹치면
          // 지우는 대신 그대로 두고 알린다 — 이런 행은 이전과 똑같이 목록에만 보인다.
          if (!normalized || exists.get(row.id, normalized)) {
            console.warn(`경로를 재정규화하지 못했습니다 (${table}): ${JSON.stringify(row.path)}`);
            continue;
          }
          update.run(normalized, row.id, row.path);
        }
      }
    },
  },
  {
    // 비밀번호를 바꿔도 이미 나간 토큰이 계속 유효했다. 토큰이 무상태(HMAC)라 서버가
    // 개별 토큰을 폐기할 수 없기 때문이다. 사용자마다 세대(epoch)를 두고 토큰에 실어,
    // 비밀번호를 바꾸면 세대를 올려 이전 세대 토큰을 한 번에 끊는다.
    version: 4,
    up: `ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // 커밋마다 저장소의 **모든** 파일 행을 snapshot_entries 에 복사했다. 파일 F 개 저장소에
    // 커밋 C 번이면 F×C 행이고, 폴더를 파일마다 올리면 F² 에 가깝다(음악 541 커밋에 14만 행).
    // 지금 상태는 repo_files 에 두고, 스냅샷에는 바뀐 경로만 앞뒤 값과 함께 적는다.
    // 과거 시점은 head 에서 그 뒤의 변경을 최근 것부터 되돌려 만든다(services/snapshots.ts).
    version: 5,
    // snapshot_entries 를 지우면 그만큼 빈 페이지가 파일에 남는다(음악 저장소 사본: 48MB → 0.9MB).
    vacuum: true,
    up: `
      -- 저장소의 지금 파일 목록(head).
      CREATE TABLE repo_files (
        repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        path       TEXT NOT NULL,
        blob_hash  TEXT NOT NULL REFERENCES blobs(hash),
        size       INTEGER NOT NULL,
        mime_type  TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, path)
      );
      CREATE INDEX idx_repo_files_blob ON repo_files(blob_hash);

      -- 스냅샷이 바꾼 경로. blob_hash 쪽이 이 스냅샷 뒤의 값(삭제면 NULL),
      -- prev_ 쪽이 앞의 값(추가면 NULL). 앞의 값이 있어야 과거로 되돌릴 수 있다.
      CREATE TABLE snapshot_changes (
        snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        path            TEXT NOT NULL,
        blob_hash       TEXT REFERENCES blobs(hash),
        size            INTEGER,
        mime_type       TEXT,
        updated_at      INTEGER,
        prev_blob_hash  TEXT REFERENCES blobs(hash),
        prev_size       INTEGER,
        prev_mime_type  TEXT,
        prev_updated_at INTEGER,
        PRIMARY KEY (snapshot_id, path)
      );
      CREATE INDEX idx_snapchanges_blob ON snapshot_changes(blob_hash);
      CREATE INDEX idx_snapchanges_prev_blob ON snapshot_changes(prev_blob_hash);

      -- 이력 목록이 스냅샷마다 파일 수·총량을 세지 않게 적어 둔다.
      ALTER TABLE snapshots ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE snapshots ADD COLUMN total_size INTEGER NOT NULL DEFAULT 0;
    `,
    run(db) {
      type Row = { path: string; blob_hash: string; size: number; mime_type: string; updated_at: number };
      const entriesOf = db.prepare<[string], Row>(
        `SELECT path, blob_hash, size, mime_type, updated_at FROM snapshot_entries WHERE snapshot_id = ?`,
      );
      const read = (snapshotId: string | null) => {
        const map = new Map<string, Row>();
        if (snapshotId) for (const row of entriesOf.all(snapshotId)) map.set(row.path, row);
        return map;
      };
      const same = (a: Row, b: Row) =>
        a.blob_hash === b.blob_hash &&
        a.size === b.size &&
        a.mime_type === b.mime_type &&
        a.updated_at === b.updated_at;

      const insertChange = db.prepare(
        `INSERT INTO snapshot_changes
           (snapshot_id, path, blob_hash, size, mime_type, updated_at,
            prev_blob_hash, prev_size, prev_mime_type, prev_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const setStats = db.prepare(`UPDATE snapshots SET file_count = ?, total_size = ? WHERE id = ?`);

      // 스냅샷마다 부모의 목록과 비교해 바뀐 것만 적는다. 오래된 것부터라 부모 행은 아직 남아 있다.
      const snapshots = db
        .prepare<[], { id: string; parent_id: string | null }>(
          `SELECT id, parent_id FROM snapshots ORDER BY created_at, id`,
        )
        .all();
      for (const snapshot of snapshots) {
        const before = read(snapshot.parent_id);
        const after = read(snapshot.id);
        let total = 0;
        for (const [path, row] of after) {
          total += row.size;
          const prev = before.get(path);
          if (prev && same(prev, row)) continue;
          insertChange.run(
            snapshot.id, path, row.blob_hash, row.size, row.mime_type, row.updated_at,
            prev?.blob_hash ?? null, prev?.size ?? null, prev?.mime_type ?? null, prev?.updated_at ?? null,
          );
        }
        for (const [path, prev] of before) {
          if (after.has(path)) continue;
          insertChange.run(
            snapshot.id, path, null, null, null, null,
            prev.blob_hash, prev.size, prev.mime_type, prev.updated_at,
          );
        }
        setStats.run(after.size, total, snapshot.id);
      }

      // 지금 상태는 저장소마다 head 의 목록 그대로.
      db.exec(`
        INSERT INTO repo_files (repo_id, path, blob_hash, size, mime_type, updated_at)
        SELECT r.id, e.path, e.blob_hash, e.size, e.mime_type, e.updated_at
          FROM repos r JOIN snapshot_entries e ON e.snapshot_id = r.head_snapshot_id;
        DROP TABLE snapshot_entries;
      `);
    },
  },
  {
    // 나눠 올리기 세션. 한 요청 본문이 프록시 한도(Cloudflare 100MB)를 넘지 않게 조각으로 받고,
    // 끊기면 받은 데까지에서 이어 간다. 서버를 다시 켜도 이어지게 DB 에 둔다.
    // 조각은 blob 저장소의 tmp/session_<id> 에 쌓인다(lib/storage.ts).
    version: 6,
    up: `
      CREATE TABLE upload_sessions (
        id         TEXT PRIMARY KEY,
        repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        received   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_upload_sessions_updated ON upload_sessions(updated_at);
      CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id);
    `,
  },
  {
    // 비밀번호 재설정 코드. 서버 운영자가 발급한다(services/password-reset.ts). 코드는 해시만 둔다.
    version: 7,
    up: `
      CREATE TABLE password_resets (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_password_resets_user ON password_resets(user_id, used_at);
    `,
  },
];
