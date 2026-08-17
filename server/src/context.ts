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
  return {
    config,
    db,
    blobs,
    close() {
      db.close();
    },
  };
}
