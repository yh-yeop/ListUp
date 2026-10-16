import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import type { UploadSource } from '../api/client';
import { desktopBridge } from './desktop';

/**
 * 파일 내용 해시(sha256, 서버의 blob 주소와 같다). 큰 파일도 메모리에 다 올리지 않고 조각씩 읽는다.
 *
 * - 같은 내용이 저장소에 이미 있으면 보내지 않는다(나눠 올리기의 즉시 완료).
 * - 서버가 받은 내용과 견줘 전송 중 손상을 잡는다.
 * - 내 폴더와 비교·동기화에서 이름이 아니라 내용으로 같은 파일을 찾는다.
 *
 * PC 앱은 main 이 Node 의 crypto 로 계산하고(빠르다), 브라우저·폰은 JS 로 계산한다.
 */

/** 한 번에 읽는 양. 읽을 때마다 한 번씩 화면에 차례를 넘긴다. */
const READ_BYTES = 4 * 1024 * 1024;

export class HashAbortedError extends Error {
  constructor() {
    super('멈췄습니다.');
    this.name = 'HashAbortedError';
  }
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function hashSource(
  source: UploadSource,
  options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<string> {
  const { signal, onProgress } = options;
  const check = () => {
    if (signal?.aborted) throw new HashAbortedError();
  };
  check();

  if (source.kind === 'desktop') {
    const folders = desktopBridge()?.folders;
    if (folders?.hash) {
      const hash = await folders.hash(source.root, source.relativePath);
      check();
      onProgress?.(source.size);
      return hash;
    }
    if (!folders) throw new Error('PC 앱에서만 읽을 수 있는 파일입니다.');
    return hashChunks(source.size, (offset, length) => folders.read(source.root, source.relativePath, offset, length), check, onProgress);
  }

  if (source.kind === 'web') {
    const file = source.file as Blob;
    return hashChunks(
      source.size,
      async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
      check,
      onProgress,
    );
  }

  const handle = new File(source.uri).open();
  try {
    return await hashChunks(
      source.size,
      async (offset, length) => {
        if (handle.offset !== offset) handle.offset = offset;
        return handle.readBytes(length);
      },
      check,
      onProgress,
    );
  } finally {
    handle.close();
  }
}

async function hashChunks(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  check: () => void,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  const hasher = sha256.create();
  let offset = 0;
  while (offset < size) {
    check();
    const bytes = await read(offset, Math.min(READ_BYTES, size - offset));
    if (bytes.byteLength === 0) throw new Error('파일을 끝까지 읽지 못했습니다. 읽는 사이 바뀌었을 수 있습니다.');
    hasher.update(bytes);
    offset += bytes.byteLength;
    onProgress?.(offset);
    await yieldToUi();
  }
  check();
  return bytesToHex(hasher.digest());
}

/**
 * 올리기 전에 해시를 먼저 계산할지. 계산하는 동안 파일을 한 번 더 읽으므로, JS 로 계산하는 곳에서는
 * 아주 큰 파일은 건너뛴다(그래도 올라가고, 서버가 해시를 계산한다). PC 앱은 크기와 상관없이 계산한다.
 */
export function shouldHashBeforeUpload(source: UploadSource): boolean {
  if (source.kind === 'desktop') return true;
  const limit = Platform.OS === 'web' ? 512 * 1024 * 1024 : 128 * 1024 * 1024;
  return source.size <= limit;
}

/**
 * 같은 파일을 여러 번 계산하지 않게 기억해 둔다 — 열쇠는 부르는 쪽이 정한다(폴더 안 경로·크기·고친 시각).
 * 앱을 켜 있는 동안만 기억한다. 동기화는 자기 기록에 따로 남긴다.
 */
const memo = new Map<string, string>();
const MEMO_LIMIT = 20_000;

export async function hashWithMemo(
  key: string,
  source: UploadSource,
  options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<string> {
  const known = memo.get(key);
  if (known) return known;
  const hash = await hashSource(source, options);
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  memo.set(key, hash);
  return hash;
}
