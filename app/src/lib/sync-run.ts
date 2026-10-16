import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api, resolveApiUrl } from '../api/client';
import { listRepoFolder, type RepoFile } from './folder-compare';
import { HashAbortedError, hashSource } from './hash';
import type { FolderRef, LocalEntry, LocalFolder } from './local-folder';
import {
  PROPOSED_DELETE,
  cachedHash,
  needsHash,
  planSync,
  type LocalSide,
  type RemoteSide,
  type SyncAction,
  type SyncBase,
  type SyncPlan,
} from './sync-plan';
import { uploadMany, type UploadProgress } from './transfer';

/**
 * 폴더 동기화 실행 — 기억해 둔 상태, 양쪽 훑기(해시), 계획 실행, 새 기준.
 * 계획은 sync-plan.ts(순수), 화면은 app/repo/[repoId]/sync.tsx.
 */

export interface SyncState {
  ref: FolderRef;
  /** 사람에게 보일 폴더 이름. */
  label: string;
  /** 저장소 안에서 이 폴더와 맞추는 곳('' 은 맨 위). */
  basePath: string;
  /** 마지막으로 맞춘 상태. 처음 맞추기 전이면 null. */
  base: SyncBase | null;
  lastSyncAt: number | null;
  /** 앱을 켜 둔 동안 1분마다 확인하고, 안전한 것(올리기·받기)만 저절로 한다. */
  auto: boolean;
}

const keyOf = (serverId: string, repoId: string) => `listup.sync.${serverId}.${repoId}`;

export async function loadSyncState(serverId: string, repoId: string): Promise<SyncState | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(serverId, repoId));
    return raw ? (JSON.parse(raw) as SyncState) : null;
  } catch {
    return null;
  }
}

export async function saveSyncState(serverId: string, repoId: string, state: SyncState | null): Promise<void> {
  if (state) await AsyncStorage.setItem(keyOf(serverId, repoId), JSON.stringify(state));
  else await AsyncStorage.removeItem(keyOf(serverId, repoId));
}

/** 훑은 양쪽 — 계획과 실행에 함께 쓴다. */
export interface SyncScan {
  local: Map<string, LocalSide>;
  remote: Map<string, RemoteSide>;
  localEntries: Map<string, LocalEntry>;
  remoteFiles: Map<string, RepoFile>;
  plan: SyncPlan;
}

/**
 * 양쪽을 훑고 계획을 세운다. 내 파일은 기준과 크기·고친 시각이 같으면 다시 읽지 않고, 판단에 필요한 것만 해시를 계산한다.
 */
export async function scanForSync(
  repoId: string,
  state: SyncState,
  folder: LocalFolder,
  options: { signal?: AbortSignal; onHashing?: (done: number, total: number, name: string) => void } = {},
): Promise<SyncScan> {
  const remoteFiles = new Map((await listRepoFolder(repoId, state.basePath)).map((file) => [file.relativePath, file]));
  const remote = new Map([...remoteFiles].map(([path, file]) => [path, { hash: file.blobHash, size: file.size }]));
  const localEntries = new Map(folder.entries.map((entry) => [entry.relativePath, entry]));

  const local = new Map<string, LocalSide>();
  const toHash: LocalEntry[] = [];
  for (const entry of folder.entries) {
    const known = cachedHash(entry.relativePath, entry, state.base);
    if (known) local.set(entry.relativePath, { hash: known, size: entry.size, mtime: entry.mtime });
    else if (needsHash(entry.relativePath, entry, state.base, remote)) toHash.push(entry);
    else local.set(entry.relativePath, { hash: null, size: entry.size, mtime: entry.mtime });
  }
  for (const [index, entry] of toHash.entries()) {
    options.onHashing?.(index, toHash.length, entry.name);
    try {
      const hash = await hashSource(entry.source, { signal: options.signal });
      local.set(entry.relativePath, { hash, size: entry.size, mtime: entry.mtime });
    } catch (err) {
      if (err instanceof HashAbortedError) throw err;
      // 읽지 못한 파일 — 이번에는 모르는 채로(올리기 대상이 되면 올리다 실패를 알려 준다).
      local.set(entry.relativePath, { hash: null, size: entry.size, mtime: entry.mtime });
    }
  }
  return { local, remote, localEntries, remoteFiles, plan: planSync(state.base, local, remote) };
}

export interface SyncOutcome {
  base: SyncBase;
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  /** 열람자: 만든 변경 제안 번호. */
  proposalNumber: number | null;
  failures: string[];
  cancelled: boolean;
}

/**
 * 고른 일을 한다. 편집자는 올리기·저장소에서 지우기를 커밋 하나로, 열람자는 변경 제안 하나로 보낸다. 받기는 내 폴더의
 * 같은 이름을 바꾸고, 내 폴더에서 지우기는 휴지통으로(PC 앱). 성공한 것만 새 기준에 넣는다.
 */
export async function applySync(
  repoId: string,
  state: SyncState,
  folder: LocalFolder,
  scan: SyncScan,
  actions: SyncAction[],
  options: {
    isEditor: boolean;
    signal?: AbortSignal;
    onProgress?: (label: string, progress: UploadProgress) => void;
  },
): Promise<SyncOutcome> {
  const base: SyncBase = { ...(state.base ?? {}) };
  for (const { path, entry } of scan.plan.adopt) {
    if (entry) base[path] = entry;
    else delete base[path];
  }
  const outcome: SyncOutcome = {
    base,
    uploaded: 0,
    downloaded: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    proposalNumber: null,
    failures: [],
    cancelled: false,
  };
  const repoPath = (path: string) => (state.basePath ? `${state.basePath}/${path}` : path);
  const of = (kind: SyncAction['kind']) => actions.filter((action) => action.kind === kind).map((action) => action.path);

  // 1. 올리기 + 저장소에서 지우기 → 커밋(편집자) 또는 제안(열람자) 하나
  const uploads = of('upload').filter((path) => scan.localEntries.has(path));
  const remoteDeletes = of('delete-remote').filter((path) => scan.remoteFiles.has(path));
  const changes: { path: string; blobHash: string | null }[] = [];
  const uploadedHashes = new Map<string, string>();
  if (uploads.length > 0) {
    const result = await uploadMany(
      repoId,
      uploads.map((path) => ({ source: scan.localEntries.get(path)!.source, path: repoPath(path) })),
      (progress) => options.onProgress?.('올리는 중', progress),
      options.signal,
    );
    if (result.cancelled) {
      outcome.cancelled = true;
      return outcome;
    }
    for (const { item, blob } of result.uploaded) {
      const path = uploads.find((candidate) => repoPath(candidate) === item.path)!;
      uploadedHashes.set(path, blob.hash);
      changes.push({ path: item.path, blobHash: blob.hash });
    }
    for (const failure of result.failures) outcome.failures.push(`${failure.item.path}: ${failure.message}`);
  }
  for (const path of remoteDeletes) changes.push({ path: repoPath(path), blobHash: null });

  if (changes.length > 0) {
    const summary = [
      uploadedHashes.size ? `올림 ${uploadedHashes.size}` : '',
      remoteDeletes.length ? `지움 ${remoteDeletes.length}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    try {
      if (options.isEditor) {
        await api.commitFiles(repoId, changes, `폴더 동기화 (${state.label}): ${summary}`);
        for (const [path, hash] of uploadedHashes) {
          const entry = scan.localEntries.get(path)!;
          base[path] = { hash, size: entry.size, mtime: entry.mtime };
        }
        for (const path of remoteDeletes) delete base[path];
        outcome.uploaded = uploadedHashes.size;
        outcome.deletedRemote = remoteDeletes.length;
      } else {
        const { proposal } = await api.createProposal(repoId, {
          title: `폴더 동기화: ${summary}`.slice(0, 120),
          description: `'${state.label}' 폴더에서 바뀐 것입니다.`,
          changes,
        });
        outcome.proposalNumber = proposal.number;
        // 반영되기 전까지는 기준을 그대로 두고 "제안함"만 적어 둔다 — 같은 것을 또 제안하지 않게.
        for (const [path, hash] of uploadedHashes) {
          base[path] = { ...(base[path] ?? { hash: '', size: 0 }), proposedHash: hash };
        }
        for (const path of remoteDeletes) base[path] = { ...(base[path] ?? { hash: '', size: 0 }), proposedHash: PROPOSED_DELETE };
        outcome.uploaded = uploadedHashes.size;
        outcome.deletedRemote = remoteDeletes.length;
      }
    } catch (err) {
      outcome.failures.push(err instanceof ApiError ? err.message : '저장소에 반영하지 못했습니다.');
    }
  }

  // 2. 받기 — 내 폴더의 같은 이름을 바꾼다
  const downloads = of('download').filter((path) => scan.remoteFiles.has(path));
  if (downloads.length > 0 && folder.save) {
    const totalBytes = downloads.reduce((sum, path) => sum + scan.remoteFiles.get(path)!.size, 0);
    let doneBytes = 0;
    for (const [index, path] of downloads.entries()) {
      if (options.signal?.aborted) {
        outcome.cancelled = true;
        break;
      }
      const file = scan.remoteFiles.get(path)!;
      const report = (fraction: number) =>
        options.onProgress?.('받는 중', {
          sentBytes: doneBytes + file.size * fraction,
          totalBytes,
          doneFiles: index,
          totalFiles: downloads.length,
          current: file.name,
        });
      report(0);
      try {
        const link = await api.downloadLink(repoId, { path: file.path });
        await folder.save(path, resolveApiUrl(link.url), report, { overwrite: true });
        // 받은 파일의 고친 시각은 다음에 훑을 때 알게 된다 — 그때 한 번 읽어 같음을 확인하고 기준에 적는다.
        base[path] = { hash: file.blobHash, size: file.size };
        outcome.downloaded += 1;
      } catch (err) {
        outcome.failures.push(`${path}: ${err instanceof Error ? err.message : '받지 못했습니다'}`);
      }
      doneBytes += file.size;
    }
  }

  // 3. 내 폴더에서 지우기
  for (const path of of('delete-local')) {
    if (!folder.remove) break;
    try {
      await folder.remove(path);
      delete base[path];
      outcome.deletedLocal += 1;
    } catch (err) {
      outcome.failures.push(`${path}: ${err instanceof Error ? err.message : '지우지 못했습니다'}`);
    }
  }
  return outcome;
}
