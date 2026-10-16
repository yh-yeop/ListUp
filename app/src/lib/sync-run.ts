import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api, resolveApiUrl, serverSupports } from '../api/client';
import { listRepoFolder, type RepoFile } from './folder-compare';
import { HashAbortedError, hashSource } from './hash';
import { openFolderRef, type FolderRef, type LocalEntry, type LocalFolder } from './local-folder';
import {
  PROPOSED_DELETE,
  cachedHash,
  isSafeToAutoApply,
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
 * 폴더 동기화 실행 — 기억해 둔 상태, 양쪽 훑기(해시), 계획 실행, 새 기준, 그리고 앱 전체에서 도는 자동 맞추기.
 * 계획은 sync-plan.ts(순수), 화면은 app/repo/[repoId]/sync.tsx.
 *
 * 한 저장소의 동기화는 한 번에 하나만 돈다(화면에서 누른 것과 자동이 겹치지 않게) — {@link withSyncLock}.
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
  /** 앱을 켜 둔 동안 1분마다 확인하고, 안전한 것(올리기·받기·옮기기)만 저절로 한다. */
  auto: boolean;
}

const keyOf = (serverId: string, repoId: string) => `listup.sync.${serverId}.${repoId}`;
const indexKeyOf = (serverId: string) => `listup.sync.index.${serverId}`;

export async function loadSyncState(serverId: string, repoId: string): Promise<SyncState | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(serverId, repoId));
    return raw ? (JSON.parse(raw) as SyncState) : null;
  } catch {
    return null;
  }
}

/** 이 서버에서 동기화를 둔 저장소들 — 자동 맞추기가 돌 곳. */
export async function listSyncedRepos(serverId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(indexKeyOf(serverId));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveSyncState(serverId: string, repoId: string, state: SyncState | null): Promise<void> {
  const ids = await listSyncedRepos(serverId);
  if (state) {
    await AsyncStorage.setItem(keyOf(serverId, repoId), JSON.stringify(state));
    if (!ids.includes(repoId)) await AsyncStorage.setItem(indexKeyOf(serverId), JSON.stringify([...ids, repoId]));
  } else {
    await AsyncStorage.removeItem(keyOf(serverId, repoId));
    await AsyncStorage.setItem(indexKeyOf(serverId), JSON.stringify(ids.filter((id) => id !== repoId)));
  }
  emit({ type: 'state', serverId, repoId, state });
}

// ---------------------------------------------------------------------------
// 잠금과 알림 — 화면과 자동 맞추기가 서로를 안다
// ---------------------------------------------------------------------------

export type SyncEvent =
  | { type: 'state'; serverId: string; repoId: string; state: SyncState | null }
  /** 자동 맞추기가 이 저장소를 다뤘다(바뀐 것이 있든 없든). 화면이 다시 확인한다. */
  | { type: 'auto-ran'; serverId: string; repoId: string; outcome: SyncOutcome | null };

const listeners = new Set<(event: SyncEvent) => void>();
const emit = (event: SyncEvent) => {
  for (const listener of listeners) listener(event);
};
export function subscribeSync(listener: (event: SyncEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const running = new Set<string>();
export const isSyncRunning = (serverId: string, repoId: string) => running.has(`${serverId}:${repoId}`);

/** 같은 저장소의 동기화를 겹쳐 돌리지 않는다. 이미 도는 중이면 null 을 돌려주고 아무것도 하지 않는다. */
export async function withSyncLock<T>(serverId: string, repoId: string, fn: () => Promise<T>): Promise<T | null> {
  const key = `${serverId}:${repoId}`;
  if (running.has(key)) return null;
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

// ---------------------------------------------------------------------------
// 훑기와 계획
// ---------------------------------------------------------------------------

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
  // 기준에 있었는데 지금 내 폴더에 없는 파일의 크기 — 같은 크기의 새 파일은 옮긴 것일 수 있어 읽어 본다.
  const missingSizes = new Set<number>();
  for (const [path, entry] of Object.entries(state.base ?? {})) if (!localEntries.has(path) && entry.hash) missingSizes.add(entry.size);

  const local = new Map<string, LocalSide>();
  const toHash: LocalEntry[] = [];
  for (const entry of folder.entries) {
    const known = cachedHash(entry.relativePath, entry, state.base);
    if (known) local.set(entry.relativePath, { hash: known, size: entry.size, mtime: entry.mtime });
    else if (needsHash(entry.relativePath, entry, state.base, remote, missingSizes)) toHash.push(entry);
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

/** 계획의 "기준만 고치면 되는 것"을 적용한 새 기준. */
export function adoptedBase(state: SyncState, scan: SyncScan): SyncBase {
  const base: SyncBase = { ...(state.base ?? {}) };
  for (const { path, entry } of scan.plan.adopt) {
    if (entry) base[path] = entry;
    else delete base[path];
  }
  return base;
}

/**
 * 확인 한 번 — 폴더를 열고 훑고, 할 일이 없어도 기준은 맞춰 둔다(처음부터 같은 폴더면 그것이 첫 기준이 된다). 열람자가
 * 제안해 뒀던 것이 닫혔으면 표시를 지워 다시 보낼 수 있게 한다. 바뀐 상태를 돌려준다(저장은 부르는 쪽이).
 */
export async function checkSync(
  repoId: string,
  state: SyncState,
  folder: LocalFolder,
  options: { signal?: AbortSignal; onHashing?: (done: number, total: number, name: string) => void } = {},
): Promise<{ scan: SyncScan; state: SyncState }> {
  let current = state;
  // 닫힌 제안의 표시를 지운다. 제안마다 한 번만 묻는다.
  const proposals = new Map<string, 'open' | 'merged' | 'closed' | 'gone'>();
  const base: SyncBase = { ...(current.base ?? {}) };
  let touched = false;
  for (const [path, entry] of Object.entries(base)) {
    if (!entry.proposedId) continue;
    let status = proposals.get(entry.proposedId);
    if (!status) {
      try {
        status = (await api.getProposal(entry.proposedId)).proposal.status;
      } catch (err) {
        status = err instanceof ApiError && err.status === 404 ? 'gone' : 'open';
      }
      proposals.set(entry.proposedId, status);
    }
    if (status === 'closed' || status === 'gone') {
      const { proposedHash: _h, proposedId: _i, ...rest } = entry;
      if (rest.hash) base[path] = rest;
      else delete base[path];
      touched = true;
    }
  }
  if (touched) current = { ...current, base };

  let scan = await scanForSync(repoId, current, folder, options);
  const firstTimeIdentical = current.base === null && scan.plan.actions.length === 0;
  if (scan.plan.adopt.length > 0 || firstTimeIdentical) {
    current = { ...current, base: adoptedBase(current, scan) };
    // 기준이 생기거나 바뀌었으니 계획도 그 기준으로 다시(훑은 것은 그대로 쓴다).
    scan = { ...scan, plan: planSync(current.base, scan.local, scan.remote) };
  }
  return { scan, state: current };
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  base: SyncBase;
  uploaded: number;
  downloaded: number;
  movedRemote: number;
  movedLocal: number;
  deletedRemote: number;
  deletedLocal: number;
  /** 열람자: 만든 변경 제안 번호. */
  proposalNumber: number | null;
  failures: string[];
  cancelled: boolean;
}

/** 자동으로 해도 되는 일만 — 지우기·충돌은 사람이. 저장소를 바꿀 수 없으면(미러) 받는 쪽만. */
export function safeActions(plan: SyncPlan, writable: boolean): SyncAction[] {
  if (!isSafeToAutoApply(plan)) return [];
  return plan.actions.filter((action) =>
    writable
      ? action.kind !== 'proposed'
      : action.kind === 'download' || action.kind === 'move-local',
  );
}

/**
 * 고른 일을 한다. 편집자는 올리기·옮기기·저장소에서 지우기를 저장소에 바로, 열람자는 변경 제안 하나로 보낸다. 받기는 내
 * 폴더의 같은 이름을 바꾸고, 내 폴더에서 옮기기·지우기는 폴더가 할 수 있을 때(PC 앱·안드로이드). 성공한 것만 새 기준에.
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
  const base = adoptedBase(state, scan);
  const outcome: SyncOutcome = {
    base,
    uploaded: 0,
    downloaded: 0,
    movedRemote: 0,
    movedLocal: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    proposalNumber: null,
    failures: [],
    cancelled: false,
  };
  const repoPath = (path: string) => (state.basePath ? `${state.basePath}/${path}` : path);
  const of = <K extends SyncAction['kind']>(kind: K) => actions.filter((action): action is Extract<SyncAction, { kind: K }> => action.kind === kind);
  const cancelled = () => {
    if (options.signal?.aborted) outcome.cancelled = true;
    return outcome.cancelled;
  };

  // 1. 저장소 쪽 — 올리기·옮기기·지우기를 커밋(편집자) 또는 제안(열람자) 하나로
  const uploads = of('upload').filter((a) => scan.localEntries.has(a.path)).map((a) => a.path);
  const remoteMoves = of('move-remote').filter((a) => scan.remoteFiles.has(a.from) && scan.localEntries.has(a.path));
  const remoteDeletes = of('delete-remote').filter((a) => scan.remoteFiles.has(a.path)).map((a) => a.path);
  const changes: ({ path: string; blobHash: string | null } | { path: string; movedFrom: string })[] = [];
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
  if (cancelled()) return outcome;
  for (const path of remoteDeletes) changes.push({ path: repoPath(path), blobHash: null });

  // 옮기기: 편집자는 이동 요청으로(다시 올리지 않는다), 열람자는 제안에 "지우기 + 같은 내용 더하기"로 담는다.
  if (options.isEditor) {
    for (const move of remoteMoves) {
      try {
        await api.movePath(repoId, repoPath(move.from), repoPath(move.path));
        const entry = scan.localEntries.get(move.path)!;
        base[move.path] = { hash: scan.remoteFiles.get(move.from)!.blobHash, size: entry.size, mtime: entry.mtime };
        delete base[move.from];
        outcome.movedRemote += 1;
      } catch (err) {
        outcome.failures.push(`${move.from} → ${move.path}: ${err instanceof ApiError ? err.message : '옮기지 못했습니다'}`);
      }
    }
  } else if (remoteMoves.length > 0) {
    // 수준 5 서버는 이동 제안을 알아듣는다 — 제안 화면에 "이동" 한 줄로 보이고, 정리할 때 한쪽만 빠지지 않는다.
    const movesKnown = await serverSupports(5).catch(() => false);
    for (const move of remoteMoves) {
      const hash = scan.remoteFiles.get(move.from)!.blobHash;
      if (movesKnown) changes.push({ path: repoPath(move.path), movedFrom: repoPath(move.from) });
      else changes.push({ path: repoPath(move.from), blobHash: null }, { path: repoPath(move.path), blobHash: hash });
      uploadedHashes.set(move.path, hash);
    }
  }

  if (changes.length > 0) {
    const summary = [
      uploadedHashes.size ? `올림 ${uploadedHashes.size}` : '',
      remoteDeletes.length ? `지움 ${remoteDeletes.length}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    try {
      if (options.isEditor) {
        const commits = changes.filter((change): change is { path: string; blobHash: string | null } => 'blobHash' in change);
        await api.commitFiles(repoId, commits, `폴더 동기화 (${state.label}): ${summary}`);
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
        // 반영되기 전까지는 기준을 그대로 두고 "제안함"만 적어 둔다 — 같은 것을 또 제안하지 않게. 새 파일은 크기·시각도
        // 적어 두어 다음에 읽지 않아도 되게 한다.
        for (const [path, hash] of uploadedHashes) {
          const entry = scan.localEntries.get(path);
          base[path] = {
            ...(base[path] ?? { hash: '', size: entry?.size ?? 0, mtime: entry?.mtime }),
            size: entry?.size ?? base[path]?.size ?? 0,
            mtime: entry?.mtime,
            proposedHash: hash,
            proposedId: proposal.id,
          };
        }
        for (const path of [...remoteDeletes, ...remoteMoves.map((m) => m.from)]) {
          base[path] = { ...(base[path] ?? { hash: '', size: 0 }), proposedHash: PROPOSED_DELETE, proposedId: proposal.id };
        }
        outcome.uploaded = uploadedHashes.size;
        outcome.deletedRemote = remoteDeletes.length;
      }
    } catch (err) {
      outcome.failures.push(err instanceof ApiError ? err.message : '저장소에 반영하지 못했습니다.');
    }
  }
  if (cancelled()) return outcome;

  // 2. 내 폴더 쪽 — 옮기기(못 하면 받고 지우기), 받기(같은 이름을 바꾼다)
  const localMoves = of('move-local').filter((a) => scan.localEntries.has(a.from) && scan.remoteFiles.has(a.path));
  const downloads = of('download').filter((a) => scan.remoteFiles.has(a.path)).map((a) => a.path);
  const localDeletes = of('delete-local').map((a) => a.path);
  for (const move of localMoves) {
    if (!folder.move) {
      downloads.push(move.path);
      localDeletes.push(move.from);
      continue;
    }
    try {
      await folder.move(move.from, move.path);
      const was = scan.localEntries.get(move.from)!;
      base[move.path] = { hash: scan.remoteFiles.get(move.path)!.blobHash, size: was.size, mtime: was.mtime };
      delete base[move.from];
      outcome.movedLocal += 1;
    } catch (err) {
      outcome.failures.push(`${move.from} → ${move.path}: ${err instanceof Error ? err.message : '옮기지 못했습니다'}`);
    }
  }
  if (downloads.length > 0 && folder.save) {
    const totalBytes = downloads.reduce((sum, path) => sum + scan.remoteFiles.get(path)!.size, 0);
    let doneBytes = 0;
    for (const [index, path] of downloads.entries()) {
      if (cancelled()) return outcome;
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
  if (cancelled()) return outcome;

  // 3. 내 폴더에서 지우기 — 멈췄으면 하지 않는다
  for (const path of localDeletes) {
    if (!folder.remove) break;
    if (cancelled()) return outcome;
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

/** 결과를 한 줄로 — 화면과 자동 맞추기가 같은 말을 쓴다. */
export function describeOutcome(outcome: SyncOutcome, isEditor: boolean): string {
  return [
    outcome.uploaded ? `${isEditor ? '올림' : '제안'} ${outcome.uploaded}` : '',
    outcome.downloaded ? `받음 ${outcome.downloaded}` : '',
    outcome.movedRemote ? `저장소에서 옮김 ${outcome.movedRemote}` : '',
    outcome.movedLocal ? `내 폴더에서 옮김 ${outcome.movedLocal}` : '',
    outcome.deletedRemote ? `저장소에서 지움 ${outcome.deletedRemote}` : '',
    outcome.deletedLocal ? `내 폴더에서 지움 ${outcome.deletedLocal}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// 자동 맞추기 — 앱 전체에서, 어느 화면에 있든
// ---------------------------------------------------------------------------

export const AUTO_SYNC_EVERY_MS = 60_000;

/**
 * 자동으로 둔 저장소 하나를 한 번 맞춘다. 지우기·충돌이 하나라도 있으면 아무것도 하지 않는다(사람이 화면에서 고른다).
 * 화면에서 돌리는 중이면 건너뛴다. 결과는 알림으로 보내고 돌려준다.
 */
export async function runAutoSync(serverId: string, repoId: string): Promise<SyncOutcome | null> {
  return withSyncLock(serverId, repoId, async () => {
    const state = await loadSyncState(serverId, repoId);
    if (!state?.auto || !state.base) return null;
    let outcome: SyncOutcome | null = null;
    try {
      const [{ repo }, folder] = await Promise.all([api.getRepo(repoId), openFolderRef(state.ref)]);
      const isEditor = repo.role === 'editor' || repo.role === 'owner';
      const writable = !repo.mirror;
      const checked = await checkSync(repoId, state, folder);
      let next = checked.state;
      const actions = safeActions(checked.scan.plan, writable);
      if (actions.length > 0) {
        outcome = await applySync(repoId, next, folder, checked.scan, actions, { isEditor });
        next = { ...next, base: outcome.base, lastSyncAt: Date.now() };
      }
      if (next !== state) await saveSyncState(serverId, repoId, next);
    } catch {
      // 폴더를 못 열거나 서버에 닿지 않는다 — 다음 번에 다시.
    }
    emit({ type: 'auto-ran', serverId, repoId, outcome });
    return outcome;
  });
}

/** 이 서버의 자동 저장소를 모두 한 번씩. */
export async function runAllAutoSyncs(serverId: string): Promise<void> {
  for (const repoId of await listSyncedRepos(serverId)) await runAutoSync(serverId, repoId);
}
