import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { tooLarge } from './errors.ts';

export interface StoredBlob {
  hash: string;
  size: number;
}

/**
 * 콘텐츠 주소 파일 저장소.
 * 경로는 `<root>/ab/cd/<hash>` — 한 디렉터리에 파일이 몰리지 않게 두 단계로 쪼갠다.
 * 같은 내용은 한 번만 저장되므로, 저장소를 옮겨도 실제 바이트는 중복되지 않는다.
 */
export class BlobStore {
  constructor(private readonly root: string) {}

  pathFor(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async has(hash: string): Promise<boolean> {
    try {
      await fsp.access(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 스트림을 임시 파일에 받아 해시를 구한 뒤 최종 위치로 rename 한다.
   * 이미 같은 해시가 있으면 임시 파일을 버린다.
   */
  async writeStream(stream: Readable, maxBytes: number): Promise<StoredBlob> {
    await fsp.mkdir(path.join(this.root, 'tmp'), { recursive: true });
    const tmpPath = path.join(
      this.root,
      'tmp',
      `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    );

    const hasher = createHash('sha256');
    let size = 0;
    let overflow = false;

    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          throw tooLarge(`파일이 너무 큽니다. 최대 ${Math.floor(maxBytes / 1024 / 1024)}MB.`);
        }
        hasher.update(chunk);
        yield chunk;
      }
    };

    try {
      await pipeline(stream, counter, fs.createWriteStream(tmpPath));
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      if (overflow) throw tooLarge(`파일이 너무 큽니다. 최대 ${Math.floor(maxBytes / 1024 / 1024)}MB.`);
      throw err;
    }

    const hash = hasher.digest('hex');
    const finalPath = this.pathFor(hash);

    try {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      // 이미 존재하면 내용이 같으므로 굳이 덮어쓰지 않는다.
      if (await this.has(hash)) {
        await fsp.rm(tmpPath, { force: true });
      } else {
        await fsp.rename(tmpPath, finalPath);
      }
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      throw err;
    }

    return { hash, size };
  }

  async writeBuffer(buffer: Buffer): Promise<StoredBlob> {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const finalPath = this.pathFor(hash);
    if (!(await this.has(hash))) {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.writeFile(finalPath, buffer);
    }
    return { hash, size: buffer.length };
  }

  createReadStream(hash: string): fs.ReadStream {
    return fs.createReadStream(this.pathFor(hash));
  }

  async read(hash: string): Promise<Buffer> {
    return fsp.readFile(this.pathFor(hash));
  }

  /** 어떤 스냅샷/제안에서도 참조하지 않는 blob 파일 제거. */
  async remove(hash: string): Promise<void> {
    await fsp.rm(this.pathFor(hash), { force: true });
  }
}
