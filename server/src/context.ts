import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { openDb } from './db/index.ts';
import { BlobStore } from './lib/storage.ts';

export interface AppContext {
  config: Config;
  db: Db;
  blobs: BlobStore;
  close(): void;
}

export function createContext(config: Config): AppContext {
  const db = openDb(config.dbPath);
  const blobs = new BlobStore(config.blobDir);
  // 이전 기동에서 끊긴 업로드가 남긴 임시 파일 정리. 아직 진행 중일 수 있는 최근 것은 남긴다.
  blobs.cleanupTemp(60 * 60 * 1000);
  return {
    config,
    db,
    blobs,
    close() {
      db.close();
    },
  };
}
