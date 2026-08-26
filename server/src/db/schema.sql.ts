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
];
