import { createHash, type Hash } from 'node:crypto';
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

/** 나눠 올리기 완료 결과. `rehashed` 는 이어 계산한 해시가 없어 세션 파일을 처음부터 다시 읽었는지. */
export interface CompletedSession extends StoredBlob {
  rehashed: boolean;
}

/**
 * 콘텐츠 주소 파일 저장소.
 * 경로는 `<root>/ab/cd/<hash>` — 한 디렉터리에 파일이 몰리지 않게 두 단계로 쪼갠다.
 * 같은 내용은 한 번만 저장되므로, 저장소를 옮겨도 실제 바이트는 중복되지 않는다.
 */
export class BlobStore {
  /**
   * 나눠 올리기 세션별로 받은 데까지 이어 계산한 해시. complete 때 큰 파일을 처음부터 다시 읽지 않으려고
   * 둔다(2GB 면 수 초 — 그동안 앱은 응답을 못 받아 타임아웃 날 수 있다). 메모리에만 있으므로 서버를
   * 다시 켜거나 순서가 어긋나면 비고, 그때는 completeSession 이 전체를 다시 읽는다.
   */
  private readonly hashers = new Map<string, { hasher: Hash; bytes: number }>();

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
    await this.moveIntoPlace(tmpPath, hash, size);
    return { hash, size };
  }

  /** 다 받은 임시 파일을 콘텐츠 주소 자리로 옮긴다. 실패하면 임시 파일을 지운다. */
  private async moveIntoPlace(tmpPath: string, hash: string, size: number): Promise<void> {
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
  }

  // -------------------------------------------------------------------------
  // 나눠 올리기 세션 — 조각을 임시 파일(tmp/session_<id>)에 이어 붙이고, 다 받으면 해시를 구해 옮긴다.
  // -------------------------------------------------------------------------

  private sessionPath(id: string): string {
    return path.join(this.tmpDir, `session_${id}`);
  }

  /** 빈 세션 파일을 만든다. */
  async createSession(id: string): Promise<void> {
    await fsp.mkdir(this.tmpDir, { recursive: true });
    await fsp.writeFile(this.sessionPath(id), '');
    this.hashers.set(id, { hasher: createHash('sha256'), bytes: 0 });
  }

  /**
   * offset 에서부터 조각을 이어 붙이고 새 길이를 돌려준다. 받기 전에 파일을 offset 으로 잘라,
   * 앞선 요청이 쓰다가 끊겨 남긴 꼬리가 섞이지 않게 한다. maxBytes 를 넘으면 413.
   */
  async appendChunk(id: string, offset: number, stream: Readable, maxBytes: number): Promise<number> {
    const filePath = this.sessionPath(id);
    await fsp.truncate(filePath, offset);
    // 이어 계산은 해시가 정확히 offset 까지일 때만. 조각은 복사본(trial)에 먹이고 다 받은 뒤에야
    // 바꿔 끼우므로, 끊긴 조각을 같은 offset 에서 다시 보내도 이어 계산이 그대로 살아 있다.
    const entry = this.hashers.get(id);
    const trial = entry && entry.bytes === offset ? entry.hasher.copy() : null;
    if (!trial) this.hashers.delete(id);
    let received = 0;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > maxBytes) throw tooLarge('조각이 너무 큽니다.');
        trial?.update(chunk);
        yield chunk;
      }
    };
    try {
      await pipeline(stream, counter, fs.createWriteStream(filePath, { flags: 'r+', start: offset, flush: true }));
    } catch (err) {
      // 반쯤 쓴 조각은 버린다 — 다음 요청이 같은 offset 에서 다시 보낸다. 해시는 이전 상태 그대로.
      await fsp.truncate(filePath, offset).catch(() => {});
      throw err;
    }
    if (trial) this.hashers.set(id, { hasher: trial, bytes: offset + received });
    return offset + received;
  }

  /**
   * 세션 파일의 해시를 구해 콘텐츠 주소 자리로 옮긴다. 이어 계산한 해시가 끝(size)까지 와 있으면 그것을
   * 쓰고, 아니면(서버 재시작·순서 어긋남) 파일을 처음부터 다시 읽는다.
   */
  async completeSession(id: string, size: number): Promise<CompletedSession> {
    const filePath = this.sessionPath(id);
    // 성공하든 실패하든 이 세션의 이어 계산은 끝이다 — 실패하면 moveIntoPlace 가 세션 파일도 지운다.
    const entry = this.hashers.get(id);
    this.hashers.delete(id);
    const stat = await fsp.stat(filePath);
    if (stat.size !== size) throw new Error(`세션 파일 크기가 기록과 다릅니다 (${stat.size} ≠ ${size}).`);
    let hash: string;
    const rehashed = !entry || entry.bytes !== size;
    if (!rehashed) {
      hash = entry.hasher.digest('hex');
    } else {
      const hasher = createHash('sha256');
      await pipeline(fs.createReadStream(filePath), async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) hasher.update(chunk);
      });
      hash = hasher.digest('hex');
    }
    await this.moveIntoPlace(filePath, hash, size);
    return { hash, size, rehashed };
  }

  async removeSession(id: string): Promise<void> {
    this.hashers.delete(id);
    await fsp.rm(this.sessionPath(id), { force: true });
  }

  /** 이어 계산 중인 세션 수 — 시험에서 정리 누수를 본다. */
  get trackedSessions(): number {
    return this.hashers.size;
  }

  /** range 를 주면 그 구간만(end 포함). */
  createReadStream(hash: string, range?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(this.pathFor(hash), range);
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
