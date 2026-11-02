import { File } from 'expo-file-system';
import { ApiError, api, currentApiBaseUrl, type UploadSource } from '../api/client';
import { desktopBridge } from './desktop';
import { forgetUpload, rememberUpload, rememberedUpload } from './upload-sessions';
import type { CommitResult, UploadSession, UploadedBlob } from '@listup/shared';
import type { UploadItem } from './pure/transfer-plan';
import type { TransferPhase } from './pure/transfer-report';
import { sessionKey } from './pure/upload-sessions';

export { remoteFilesOf, splitUnchanged, type RemoteFiles, type UploadItem } from './pure/transfer-plan';

/**
 * 파일 올리기 — 나눠 올리기 세션으로 조각씩 보낸다(서버 routes/uploads.ts).
 *
 * - 한 요청이 프록시 한도(Cloudflare 100MB)를 넘지 않는다.
 * - 끊기면 5분 동안 서버에 받은 위치를 물어 거기서부터 다시 보낸다. 그래도 안 되면 그만두되 서버의 세션은
 *   남기고 기기에 기억해 둔다 — 같은 파일을 다시 올리면 받은 데서 이어 간다(lib/upload-sessions.ts, 20시간).
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
  /** 보내는 중·서버에서 마무리하는 중·커밋(제안) 만드는 중 — 카드 제목과 멈추기 버튼이 따른다(pure/transfer-report). */
  phase: TransferPhase;
}

/** uploadInChunks 가 알리는 단계 — 파일 하나 안에서는 보내는 중이거나 마무리하는 중이다. */
export type ChunkPhase = Extract<TransferPhase, 'sending' | 'finishing'>;

/** 연결이 끊긴 뒤 다시 이어 보려고 기다리는 시간. 넘으면 TransferOffline 으로 그만둔다. */
export const RETRY_WINDOW_MS = 5 * 60_000;

/** n 번째(0부터) 다시 시도 전에 기다리는 시간 — 1·2·4·8·15·15…초. */
const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 15_000);

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

/**
 * 서버가 바뀌었거나 로그아웃해서 그만둔 전송의 signal. 사용자가 멈춘 것과 달리 그때까지 올린 파일도
 * 반영하지 않는다 — 요청이 이제 다른 서버(또는 토큰 없이)로 가기 때문이다. abort(reason) 은 플랫폼마다
 * 지원이 달라(RN 의 AbortController) reason 대신 따로 적어 둔다.
 */
const abandonedSignals = new WeakSet<AbortSignal>();

/** 전송을 그만둔다 — 멈춤처럼 끊되, 올린 파일을 반영하지 않게 표시한다(lib/transfer-store.ts). */
export function abandonTransfer(controller: AbortController): void {
  abandonedSignals.add(controller.signal);
  controller.abort();
}

/** signal 이 서버 전환·로그아웃으로 끊겼는지. */
export const isAbandoned = (signal?: AbortSignal) => !!signal && abandonedSignals.has(signal);

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
 * 연결이 끊긴 채 다시 이어 보는 창(RETRY_WINDOW_MS)을 넘겼다. 서버의 세션과 기기의 기억은 남아 있어, 연결된
 * 뒤 같은 파일을 다시 올리면 받은 데서 이어 간다. 여러 파일이면 나머지도 보내지 않는다(uploadMany).
 */
export class TransferOffline extends Error {
  constructor() {
    super('연결이 끊겼습니다.');
    this.name = 'TransferOffline';
  }
}

/**
 * 끊긴 뒤 다시 시도하는 창. 처음 끊긴 때부터 5분 안이면 1·2·4·8·15·15…초 기다리고, 넘으면 TransferOffline.
 * 요청이 하나라도 되면 reset 으로 창을 새로 연다.
 */
class RetryWindow {
  private since: number | null = null;
  private attempt = 0;

  constructor(private readonly signal?: AbortSignal) {}

  async wait(): Promise<void> {
    const now = Date.now();
    if (this.since === null) this.since = now;
    if (now - this.since >= RETRY_WINDOW_MS) throw new TransferOffline();
    await wait(retryDelay(this.attempt), this.signal);
    this.attempt += 1;
    throwIfCancelled(this.signal);
  }

  reset(): void {
    this.since = null;
    this.attempt = 0;
  }
}

/** 연결이 끊긴 것(응답이 없음·타임아웃). */
const isOffline = (err: unknown) => err instanceof ApiError && err.status === 0;

/** 서버가 받은 위치를 알려 준 409 — 앞선 응답을 못 받았거나, 조각이 겹쳤거나, 다른 요청을 받는 중. */
function receivedOf(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const received = (err.details as { received?: unknown } | undefined)?.received;
  return typeof received === 'number' ? received : null;
}

/** 지금 서버·저장소에 이 파일을 올리는 세션의 기억 키. 고른 서버가 없거나 고친 시각을 모르면 null. */
function rememberKey(repoId: string, source: UploadSource): string | null {
  const baseUrl = currentApiBaseUrl();
  return baseUrl === null ? null : sessionKey(baseUrl, repoId, source);
}

/**
 * 올릴 세션을 연다. 기억해 둔 세션이 있고 서버에 그대로(같은 이름·크기) 있으면 거기서 이어 가고(resumed),
 * 없거나 다르면 잊고 새로 만든다. 연결이 끊겨 있으면 창 안에서 다시 묻는다 — 끊겼다고 기억을 버리지 않는다.
 */
async function openSession(
  repoId: string,
  source: UploadSource,
  key: string | null,
  retry: RetryWindow,
): Promise<{ upload: UploadSession; resumed: boolean }> {
  const remembered = key ? await rememberedUpload(key) : null;
  if (key && remembered) {
    for (;;) {
      try {
        const { upload } = await api.getUpload(remembered);
        retry.reset();
        if (upload.repoId === repoId && upload.name === source.name && upload.size === source.size) {
          return { upload, resumed: true };
        }
        break;
      } catch (err) {
        if (!isOffline(err)) break;
        await retry.wait();
      }
    }
    await forgetUpload(key);
  }
  return { upload: await startSession(repoId, source, key, retry), resumed: false };
}

/** 새 세션을 만들고 기억한다. 연결이 끊겨 있으면 창 안에서 다시. */
async function startSession(
  repoId: string,
  source: UploadSource,
  key: string | null,
  retry: RetryWindow,
): Promise<UploadSession> {
  for (;;) {
    try {
      const { upload } = await api.startUpload(repoId, { name: source.name, size: source.size });
      retry.reset();
      if (key) void rememberUpload(key, upload.id);
      return upload;
    } catch (err) {
      if (!isOffline(err)) throw err;
      await retry.wait();
    }
  }
}

/**
 * 파일 하나를 나눠 올려 blob 을 받는다. onSent 에는 이 파일에서 보낸 바이트와 단계를 알려 준다 — 마지막 조각을
 * 보낸 뒤 complete 를 기다리는 동안은 finishing(큰 파일은 서버가 해시를 맞춰 보느라 시간이 걸린다).
 *
 * - 같은 파일(경로·크기·고친 시각, pure/upload-sessions)을 올리다 끊긴 세션이 기억돼 있으면 거기서 이어 간다.
 *   이어 간 세션이 첫 요청부터 막히면(서버에서 세션 파일만 사라졌다든지) 버리고 새 세션으로 한 번 더.
 * - 연결이 끊기면 5분 창 안에서 받은 위치를 물어 이어 가고, 넘으면 TransferOffline(세션·기억은 남긴다).
 * - complete 의 응답을 못 받았으면 창 안에서 다시 부른다 — 서버가 10분 동안 같은 결과를 준다.
 * - signal 로 멈추면 보내던 조각을 끊고 TransferCancelled 를 던진다. 서버의 세션을 치우는 것은 멈췄을 때와
 *   다시 해도 소용없는 실패(4xx·파일을 못 읽음)일 때뿐이다 — 끊김·서버 오류(5xx)에는 남겨 이어 갈 수 있게.
 */
export async function uploadInChunks(
  repoId: string,
  source: UploadSource,
  onSent: (bytes: number, phase: ChunkPhase) => void,
  signal?: AbortSignal,
): Promise<UploadedBlob> {
  throwIfCancelled(signal);
  const key = rememberKey(repoId, source);
  const retry = new RetryWindow(signal);
  const reader = openReader(source);
  let upload: UploadSession | null = null;
  let finished = false;
  /** 세션을 서버에서 치우고 기억에서 지운다 — 멈춤·4xx·파일을 못 읽음. 끊김·5xx 는 남긴다. */
  let discard = false;
  try {
    const opened = await openSession(repoId, source, key, retry);
    upload = opened.upload;
    let offset = upload.received;
    // 이어 간 세션의 첫 응답을 아직 못 받았다 — 이때 막히면 그 세션은 버린다.
    let firstOfResumed = opened.resumed;
    if (offset > 0) onSent(offset, 'sending');
    for (;;) {
      throwIfCancelled(signal);
      try {
        if (offset < upload.size) {
          const length = Math.min(upload.chunkSize, upload.size - offset);
          const bytes = await reader.read(offset, length);
          const base = offset;
          const { upload: next } = await api.putChunk(
            upload.id,
            offset,
            bytes,
            (loaded) => onSent(base + loaded, 'sending'),
            signal,
          );
          offset = next.received;
          onSent(offset, 'sending');
        } else {
          // 다 보냈다 — 서버가 맞춰 보는 동안 멈추기는 (마지막 파일이면) 숨는다.
          onSent(upload.size, 'finishing');
          const { blob } = await api.completeUpload(upload.id);
          finished = true;
          if (key) void forgetUpload(key);
          return blob;
        }
        firstOfResumed = false;
        retry.reset();
      } catch (err) {
        // 멈춰서 끊긴 것은 다시 보내지 않는다.
        throwIfCancelled(signal);
        const received = receivedOf(err);
        if (received !== null) {
          firstOfResumed = false;
          if (received === offset || (offset >= upload.size && received >= upload.size)) {
            // 이 세션에 다른 요청(끊긴 앞 요청·앞선 complete)을 받는 중이다 — 끝나기를 기다렸다 다시.
            await retry.wait();
          } else {
            // 서버가 받은 위치가 다르다(앞선 응답을 못 받았거나, complete 했는데 덜 받았다) — 거기서 다시.
            offset = received;
          }
          continue;
        }
        if (isOffline(err)) {
          // 연결이 끊긴 것이면 잠시 뒤 받은 위치를 물어 이어 간다. 다 보낸 뒤였다면 complete 를 다시 부른다.
          await retry.wait();
          if (offset < upload.size) {
            try {
              offset = (await api.getUpload(upload.id)).upload.received;
            } catch {
              // 아직도 닿지 않으면 다음 번에 다시 묻는다.
            }
          }
          continue;
        }
        if (firstOfResumed && err instanceof ApiError) {
          // 기억해 둔 세션이 받은 위치는 알려 주면서 조각·완료는 못 받는다 — 버리고 처음부터 한 번 더.
          firstOfResumed = false;
          void api.cancelUpload(upload.id).catch(() => {});
          if (key) await forgetUpload(key);
          upload = await startSession(repoId, source, key, retry);
          offset = upload.received;
          onSent(offset, 'sending');
          continue;
        }
        // 다시 해도 소용없는 실패면 세션을 치운다. 서버 오류(5xx)는 남겨 다음에 이어 갈 수 있게.
        discard = !(err instanceof ApiError) || (err.status >= 400 && err.status < 500);
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof TransferCancelled) discard = true;
    throw err;
  } finally {
    reader.close();
    // 서버를 바꿨거나 로그아웃해 그만둔 것이면 치울 수도 없다(요청이 이제 다른 서버로 간다) — 서버 GC 몫.
    if (upload && !finished && discard && !isAbandoned(signal)) {
      void api.cancelUpload(upload.id).catch(() => {});
      if (key) void forgetUpload(key);
    }
  }
}

export interface UploadOutcome {
  /** 올린 파일 (커밋·제안에 담는다) */
  uploaded: { item: UploadItem; blob: UploadedBlob }[];
  /** 올리지 못한 파일과 이유 */
  failures: { item: UploadItem; message: string }[];
  /** 사용자가 도중에 멈췄다. 멈춘 뒤의 파일은 uploaded 에도 failures 에도 없다. */
  cancelled: boolean;
  /**
   * 연결이 오래 끊겨 그만뒀다(TransferOffline). 끊긴 파일과 그 뒤의 파일은 failures 에 있고, 끊긴 파일의 세션은
   * 남아 있어 같은 파일을 다시 올리면 이어 간다.
   */
  offline: boolean;
}

/**
 * 파일 여러 개를 차례로 올린다. 권한이 없거나 연결이 끊겨 그만뒀으면 나머지도 같은 이유로 안 되므로 거기서 멈춘다.
 * signal 로 멈추면 올리던 파일을 끊고, 그때까지 다 올린 파일만 돌려준다.
 */
export async function uploadMany(
  repoId: string,
  items: UploadItem[],
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const totalBytes = items.reduce((sum, item) => sum + item.source.size, 0);
  const outcome: UploadOutcome = { uploaded: [], failures: [], cancelled: false, offline: false };
  let doneBytes = 0;
  for (const [index, item] of items.entries()) {
    if (signal?.aborted) {
      outcome.cancelled = true;
      break;
    }
    const report = (sent: number, phase: ChunkPhase) =>
      onProgress({
        sentBytes: doneBytes + sent,
        totalBytes,
        doneFiles: index,
        totalFiles: items.length,
        current: item.source.name,
        phase,
      });
    report(0, 'sending');
    try {
      const blob = await uploadInChunks(repoId, item.source, report, signal);
      outcome.uploaded.push({ item, blob });
    } catch (err) {
      if (err instanceof TransferCancelled) {
        outcome.cancelled = true;
        break;
      }
      if (err instanceof TransferOffline) {
        outcome.offline = true;
        outcome.failures.push({ item, message: err.message });
        for (const rest of items.slice(index + 1)) {
          outcome.failures.push({ item: rest, message: '연결이 끊겨 보내지 못했습니다' });
        }
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
  onProgress({ ...committingProgress(items), phase: 'sending' });
  return outcome;
}

/** 다 올린 뒤 커밋·제안을 만드는 중이라고 알릴 진행 정보 — 이때는 멈추기가 없다. */
export function committingProgress(items: UploadItem[]): UploadProgress {
  const totalBytes = items.reduce((sum, item) => sum + item.source.size, 0);
  return { sentBytes: totalBytes, totalBytes, doneFiles: items.length, totalFiles: items.length, current: '', phase: 'committing' };
}

/**
 * 다 올린 파일을 커밋(제안)하지 못했다. 올린 blob 은 서버에 남지만 저장소에는 없으므로, 몇 개가 반영되지
 * 않았는지 알릴 수 있게 그 수를 같이 들고 간다(pure/transfer-report describeCommitFailure).
 */
export class CommitFailed extends Error {
  /** 서버가 돌려준 오류(대개 ApiError) */
  readonly error: unknown;
  /** 다 올렸지만 반영되지 않은 파일 수 */
  readonly uploaded: number;

  constructor(error: unknown, uploaded: number) {
    super(error instanceof Error ? error.message : '반영하지 못했습니다.');
    this.name = 'CommitFailed';
    this.error = error;
    this.uploaded = uploaded;
  }
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
  if (outcome.uploaded.length === 0 || isAbandoned(signal)) return { ...outcome, commit: null };
  onProgress(committingProgress(items));
  try {
    const commit = await api.commitFiles(
      repoId,
      outcome.uploaded.map(({ item, blob }) => ({ path: item.path, blobHash: blob.hash })),
    );
    return { ...outcome, commit };
  } catch (err) {
    throw new CommitFailed(err, outcome.uploaded.length);
  }
}
