import { File } from 'expo-file-system';
import { ApiError, api, type UploadSource } from '../api/client';
import { desktopBridge } from './desktop';
import type { CommitResult, UploadedBlob } from '@listup/shared';
import type { UploadItem } from './pure/transfer-plan';

export { remoteFilesOf, splitUnchanged, type RemoteFiles, type UploadItem } from './pure/transfer-plan';

/**
 * 파일 올리기 — 나눠 올리기 세션으로 조각씩 보낸다(서버 routes/uploads.ts).
 *
 * - 한 요청이 프록시 한도(Cloudflare 100MB)를 넘지 않는다.
 * - 끊기면 서버에 받은 위치를 물어 거기서부터 다시 보낸다(몇 번까지).
 * - 조각 안에서도 보낸 바이트를 알려 줘 진행률이 부드럽다.
 * - 여러 파일·폴더는 다 올린 뒤 **커밋 하나**로 반영한다 — 파일마다 스냅샷이 생기지 않게.
 */

export interface UploadProgress {
  /** 지금까지 보낸 바이트 (모든 파일 합) */
  sentBytes: number;
  totalBytes: number;
  /** 다 올린 파일 수 */
  doneFiles: number;
  totalFiles: number;
  /** 지금 올리는 파일 이름 */
  current: string;
}

/** 조각을 다시 보내는 최대 횟수 (연속 실패). */
const MAX_RETRIES = 5;

/** 소스에서 offset 부터 length 바이트를 읽는다. 웹은 File.slice(복사 없음), 네이티브는 파일 핸들. */
interface ChunkReader {
  read(offset: number, length: number): Promise<Blob | Uint8Array>;
  close(): void;
}

function openReader(source: UploadSource): ChunkReader {
  if (source.kind === 'web') {
    return {
      read: async (offset, length) => source.file.slice(offset, offset + length),
      close: () => {},
    };
  }
  if (source.kind === 'desktop') {
    const folders = desktopBridge()?.folders;
    if (!folders) throw new ApiError(0, 'internal', 'PC 앱에서만 올릴 수 있는 파일입니다.');
    return {
      read: (offset, length) => folders.read(source.root, source.relativePath, offset, length),
      close: () => {},
    };
  }
  // 네이티브: 파일 전체를 메모리로 읽지 않고 조각만 읽는다.
  const handle = new File(source.uri).open();
  return {
    read: async (offset, length) => {
      if (handle.offset !== offset) handle.offset = offset;
      return handle.readBytes(length);
    },
    close: () => handle.close(),
  };
}

/** 사용자가 멈췄다. 실패가 아니므로 실패 목록에 넣지 않는다. */
export class TransferCancelled extends Error {
  constructor() {
    super('멈췄습니다.');
    this.name = 'TransferCancelled';
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferCancelled();
}

/** ms 만큼 기다린다. 멈추면 바로 끝난다. */
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

/**
 * 파일 하나를 나눠 올려 blob 을 받는다. onSent 에는 이 파일에서 보낸 바이트를 알려 준다.
 * signal 로 멈추면 보내던 조각을 끊고 TransferCancelled 를 던진다(서버의 세션은 치운다).
 */
export async function uploadInChunks(
  repoId: string,
  source: UploadSource,
  onSent: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<UploadedBlob> {
  throwIfCancelled(signal);
  const { upload } = await api.startUpload(repoId, { name: source.name, size: source.size });
  const reader = openReader(source);
  let finished = false;
  try {
    let offset = upload.received;
    let retries = 0;
    while (offset < upload.size) {
      throwIfCancelled(signal);
      const length = Math.min(upload.chunkSize, upload.size - offset);
      try {
        const bytes = await reader.read(offset, length);
        const base = offset;
        const { upload: next } = await api.putChunk(
          upload.id,
          offset,
          bytes,
          (loaded) => onSent(base + loaded),
          signal,
        );
        offset = next.received;
        retries = 0;
        onSent(offset);
      } catch (err) {
        // 멈춰서 끊긴 것은 다시 보내지 않는다.
        throwIfCancelled(signal);
        // 서버가 받은 위치를 알려 주면(앞선 응답을 못 받았거나 조각이 겹침) 거기서 다시.
        const received = (err as ApiError)?.details as { received?: unknown } | undefined;
        if (err instanceof ApiError && err.status === 409 && typeof received?.received === 'number') {
          offset = received.received;
          continue;
        }
        // 연결이 끊긴 것이면 잠시 뒤 받은 위치를 물어 이어 간다.
        if (err instanceof ApiError && err.status === 0 && retries < MAX_RETRIES) {
          retries += 1;
          await wait(Math.min(1000 * 2 ** (retries - 1), 15_000), signal);
          throwIfCancelled(signal);
          try {
            offset = (await api.getUpload(upload.id)).upload.received;
          } catch {
            // 아직도 닿지 않으면 다음 번에 다시 묻는다.
          }
          continue;
        }
        throw err;
      }
    }
    throwIfCancelled(signal);
    const { blob } = await api.completeUpload(upload.id);
    finished = true;
    return blob;
  } finally {
    reader.close();
    // 실패로 멈췄다면 서버에 남은 세션을 치운다(못 치워도 서버 GC 가 치운다).
    if (!finished) void api.cancelUpload(upload.id).catch(() => {});
  }
}

export interface UploadOutcome {
  /** 올린 파일 (커밋·제안에 담는다) */
  uploaded: { item: UploadItem; blob: UploadedBlob }[];
  /** 올리지 못한 파일과 이유 */
  failures: { item: UploadItem; message: string }[];
  /** 사용자가 도중에 멈췄다. 멈춘 뒤의 파일은 uploaded 에도 failures 에도 없다. */
  cancelled: boolean;
}

/**
 * 파일 여러 개를 차례로 올린다. 권한이 없으면 나머지도 같은 이유로 실패하므로 거기서 멈춘다.
 * signal 로 멈추면 올리던 파일을 끊고, 그때까지 다 올린 파일만 돌려준다.
 */
export async function uploadMany(
  repoId: string,
  items: UploadItem[],
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const totalBytes = items.reduce((sum, item) => sum + item.source.size, 0);
  const outcome: UploadOutcome = { uploaded: [], failures: [], cancelled: false };
  let doneBytes = 0;
  for (const [index, item] of items.entries()) {
    if (signal?.aborted) {
      outcome.cancelled = true;
      break;
    }
    const report = (sent: number) =>
      onProgress({
        sentBytes: doneBytes + sent,
        totalBytes,
        doneFiles: index,
        totalFiles: items.length,
        current: item.source.name,
      });
    report(0);
    try {
      const blob = await uploadInChunks(repoId, item.source, report, signal);
      outcome.uploaded.push({ item, blob });
    } catch (err) {
      if (err instanceof TransferCancelled) {
        outcome.cancelled = true;
        break;
      }
      outcome.failures.push({ item, message: err instanceof ApiError ? err.message : '올리지 못했습니다.' });
      if (err instanceof ApiError && (err.code === 'forbidden' || err.status === 401)) {
        for (const rest of items.slice(index + 1)) outcome.failures.push({ item: rest, message: '권한 없음' });
        break;
      }
    }
    doneBytes += item.source.size;
  }
  onProgress({ sentBytes: totalBytes, totalBytes, doneFiles: items.length, totalFiles: items.length, current: '' });
  return outcome;
}

/**
 * 파일 여러 개를 올려 커밋 하나로 반영한다. 하나도 못 올렸으면 커밋하지 않는다.
 * 도중에 멈춰도 그때까지 다 올린 파일은 반영한다 — 큰 폴더를 멈췄을 때 올린 만큼은 남게.
 */
export async function uploadAndCommit(
  repoId: string,
  items: UploadItem[],
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome & { commit: CommitResult | null }> {
  const outcome = await uploadMany(repoId, items, onProgress, signal);
  if (outcome.uploaded.length === 0) return { ...outcome, commit: null };
  const commit = await api.commitFiles(
    repoId,
    outcome.uploaded.map(({ item, blob }) => ({ path: item.path, blobHash: blob.hash })),
  );
  return { ...outcome, commit };
}
