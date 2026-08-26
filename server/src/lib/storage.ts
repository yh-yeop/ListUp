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

  private get tmpDir(): string {
    return path.join(this.root, 'tmp');
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
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const tmpPath = path.join(
      this.tmpDir,
      `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    );

    const hasher = createHash('sha256');
    let size = 0;
    let overflow = false;
    const limitError = () =>
      tooLarge(`파일이 너무 큽니다. 최대 ${Math.floor(maxBytes / 1024 / 1024)}MB.`);

    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          throw limitError();
        }
        hasher.update(chunk);
        yield chunk;
      }
    };

    try {
      // flush: 닫기 전에 fsync 해서 크래시·정전 뒤에 rename 된 파일이 비어 있지 않게 한다.
      await pipeline(stream, counter, fs.createWriteStream(tmpPath, { flush: true }));
      // @fastify/multipart 는 한도에 닿으면 에러 없이 스트림을 자르고 truncated 만 세운다
      // (throwFileSizeLimit 은 toBuffer() 경로에서만 동작). 잘린 파일을 커밋하면 안 된다.
      if ((stream as { truncated?: boolean }).truncated === true) {
        overflow = true;
        throw limitError();
      }
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      if (overflow) throw limitError();
      throw err;
    }

    const hash = hasher.digest('hex');
    const finalPath = this.pathFor(hash);

    try {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      // 이미 존재하면 내용이 같으므로 굳이 덮어쓰지 않는다.
      // 단, 크기가 다르면(이전 쓰기가 중간에 끊긴 손상본) 방금 받은 것으로 교체한다.
      const existing = await fsp.stat(finalPath).catch(() => null);
      if (existing && existing.size === size) {
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

  /**
   * 업로드가 끊겨 남은 임시 파일(`tmp/up_*`) 중 maxAgeMs 보다 오래된 것을 지우고 개수를 돌려준다.
   * 기동 시 한 번 부르는 용도라 동기다. 임시 디렉터리가 아직 없으면 0.
   */
  cleanupTemp(maxAgeMs: number): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.tmpDir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('up_')) continue;
      const filePath = path.join(this.tmpDir, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) {
          fs.rmSync(filePath, { force: true });
          removed += 1;
        }
      } catch {
        // 진행 중인 업로드가 방금 옮겨 갔을 수 있다 — 건너뛴다.
      }
    }
    return removed;
  }
}
