import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net, shell } from 'electron';
import type { LocalFileEntry } from '@listup/shared';

/**
 * 내 폴더 — 창이 "내 폴더와 비교"에서 쓴다. 창은 이번 실행에서 대화상자로 고른 폴더(roots) 안만 다룰 수 있다:
 * 창의 코드가 잘못되거나 고장 나도 아무 파일이나 읽고 쓰지 못하게.
 */

/** 훑는 최대 파일 수. 넘으면 멈추고 알린다. */
const MAX_SCAN = 20_000;
/** 비교에 넣지 않는 OS 가 만든 파일. */
const JUNK = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const PART_SUFFIX = '.listup-part';

const roots = new Set<string>();

export function allowRoot(root: string): void {
  roots.add(path.resolve(root));
}

export function isAllowedRoot(root: string): boolean {
  return roots.has(path.resolve(root));
}

/** 고른 폴더 안의 경로로 푼다. 밖으로 나가거나 고른 적 없는 폴더면 던진다. */
function resolveInside(root: string, relativePath: string): string {
  const base = path.resolve(root);
  if (!roots.has(base)) throw new Error('고르지 않은 폴더입니다. 폴더를 다시 골라 주세요.');
  const target = path.resolve(base, ...relativePath.split('/'));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('폴더 밖의 경로입니다.');
  return target;
}

export async function scanFolder(root: string): Promise<{ entries: LocalFileEntry[]; truncated: boolean }> {
  const base = resolveInside(root, '');
  const entries: LocalFileEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items: fs.Dirent[];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 읽을 권한이 없는 폴더는 건너뛴다.
    }
    for (const item of items) {
      if (entries.length >= MAX_SCAN) {
        truncated = true;
        return;
      }
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      // 바로가기(심볼릭 링크)는 따라가지 않는다 — 폴더 밖으로 나가거나 돌고 돈다.
      if (item.isDirectory()) await walk(full, relativePath);
      else if (item.isFile() && !JUNK.has(item.name.toLowerCase()) && !item.name.endsWith(PART_SUFFIX)) {
        try {
          const stat = await fsp.stat(full);
          entries.push({ relativePath, size: stat.size, mtime: Math.round(stat.mtimeMs) });
        } catch {
          // 훑는 사이 지워졌다.
        }
      }
    }
  };
  await walk(base, '');
  return { entries, truncated };
}

export async function readChunk(root: string, relativePath: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fsp.open(resolveInside(root, relativePath), 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 같은 이름이 있으면 "이름 (1).확장자". */
function freeName(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let i = 1; ; i += 1) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** 파일 내용의 sha256 — 창이 JS 로 계산하는 것보다 훨씬 빠르다. */
export async function hashFile(root: string, relativePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(resolveInside(root, relativePath)), hash);
  return hash.digest('hex');
}

/** OS 휴지통으로 — 동기화로 지운 파일을 사용자가 되살릴 수 있게. */
export async function trashFile(root: string, relativePath: string): Promise<void> {
  const target = resolveInside(root, relativePath);
  if (target === path.resolve(root)) throw new Error('폴더 자체는 지울 수 없습니다.');
  await shell.trashItem(target);
}

/** 폴더 안에서 옮기기·이름 바꾸기 — 동기화가 저장소에서 옮긴 파일을 따라간다. 덮어쓰지 않는다. */
export async function moveFile(root: string, from: string, to: string): Promise<void> {
  const source = resolveInside(root, from);
  const target = resolveInside(root, to);
  if (fs.existsSync(target)) throw new Error(`가는 자리에 이미 파일이 있습니다: ${to}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(source, target);
}

/** 받아서 임시 이름으로 쓴 뒤 옮긴다 — 끊겨도 반쯤 받은 파일이 진짜 이름으로 남지 않게. */
export async function saveUrl(
  root: string,
  relativePath: string,
  url: string,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const wanted = resolveInside(root, relativePath);
  if (!/^https?:\/\//i.test(url)) throw new Error('받을 주소가 올바르지 않습니다.');
  await fsp.mkdir(path.dirname(wanted), { recursive: true });
  const part = `${wanted}${PART_SUFFIX}`;
  const response = await net.fetch(url);
  if (!response.ok || !response.body) throw new Error(`받지 못했습니다 (${response.status}).`);
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), fs.createWriteStream(part));
    const target = options.overwrite ? wanted : freeName(wanted);
    await fsp.rename(part, target);
    return path.relative(path.resolve(root), target).split(path.sep).join('/');
  } catch (err) {
    await fsp.rm(part, { force: true });
    throw err;
  }
}
