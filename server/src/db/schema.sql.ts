/**
 * 스키마 정의. 단일 마이그레이션으로 시작하고, 이후 변경은 MIGRATIONS 배열에
 * 항목을 덧붙이는 방식으로 관리한다 (user_version 으로 적용 여부 추적).
 */
export const MIGRATIONS: { version: number; up: string }[] = [
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
];
