import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 이 컴퓨터의 파일 — 내려받아 저장하기와 올릴 파일 읽기.
 *
 * MCP 서버의 작업 폴더는 클라이언트마다 달라 상대 경로가 어디를 가리킬지 알 수 없으므로 절대 경로만 받는다.
 */

export function requireAbsolute(localPath: string): string {
  if (!path.isAbsolute(localPath)) throw new Error(`절대 경로를 주세요: ${localPath}`);
  return path.resolve(localPath);
}

/**
 * 응답 본문을 `localPath` 에 저장한다. `overwrite` 가 아니면 이미 있는 파일은 건드리지 않는다.
 *
 * 임시 파일에 다 받은 뒤 옮기므로, 받다가 끊겨도 덮어쓸 파일이 반쯤 망가지지 않는다. 덮어쓰지 않을 때는
 * 받기 전에 최종 경로를 `wx`(없을 때만 만들기)로 먼저 잡는다 — 확인하고 쓰는 사이에 생긴 파일을 덮지 않게.
 */
export async function saveResponse(res: Response, localPath: string, overwrite: boolean): Promise<number> {
  const target = requireAbsolute(localPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let reserved = false;
  if (!overwrite) {
    try {
      await (await fsp.open(target, 'wx')).close();
      reserved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`이미 있는 파일입니다: ${target} (덮어쓰려면 overwrite: true)`);
      }
      throw err;
    }
  }
  const temp = `${target}.listup-${randomBytes(4).toString('hex')}.part`;
  try {
    if (!res.body) throw new Error('응답에 본문이 없습니다.');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(temp, { flags: 'wx' }));
    await fsp.rename(temp, target);
    return (await fsp.stat(target)).size;
  } catch (err) {
    await fsp.rm(temp, { force: true });
    if (reserved) await fsp.rm(target, { force: true });
    throw err;
  }
}
