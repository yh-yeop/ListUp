import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { BlobStore } from '../src/lib/storage.ts';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const MAX = 1024 * 1024;

/** 앞부분만 보내고 끊기는 조각 — 회선이 중간에 끊긴 PUT 흉내. */
function brokenStream(data: Buffer): Readable {
  return Readable.from(
    (async function* () {
      yield data.subarray(0, Math.floor(data.length / 2));
      throw new Error('연결이 끊겼습니다');
    })(),
  );
}

describe('BlobStore 나눠 올리기 — 해시 이어 계산', () => {
  let root: string;
  let store: BlobStore;
  // 마지막 조각이 홀수 크기라 경계가 조각 크기에 맞지 않는다.
  const data = randomBytes(4096 * 2 + 1001);
  const chunks = [data.subarray(0, 4096), data.subarray(4096, 8192), data.subarray(8192)];
  const offsets = [0, 4096, 8192];

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-storage-'));
    store = new BlobStore(root);
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sendAll = async (s: BlobStore, id: string, from = 0) => {
    for (let i = from; i < chunks.length; i += 1) {
      assert.equal(await s.appendChunk(id, offsets[i], Readable.from([chunks[i]]), MAX), offsets[i] + chunks[i].length);
    }
  };

  it('조각 3개를 이어 계산한 해시는 전체 sha256 과 같고, 다시 읽지 않는다', async () => {
    await store.createSession('a');
    await sendAll(store, 'a');
    const done = await store.completeSession('a', data.length);
    assert.deepEqual(done, { hash: sha256(data), size: data.length, rehashed: false });
    assert.equal(fs.readFileSync(store.pathFor(done.hash)).equals(data), true);
    assert.equal(store.trackedSessions, 0, 'complete 뒤에는 이어 계산을 놓는다');
  });

  it('끊긴 조각을 같은 offset 에서 다시 보내도 이어 계산이 살아 있다', async () => {
    await store.createSession('c');
    assert.equal(await store.appendChunk('c', 0, Readable.from([chunks[0]]), MAX), 4096);
    // 두 번째 조각이 반쯤 가다 끊긴다 → 파일은 offset 으로 되돌아가고, 해시도 이전 상태 그대로여야 한다.
    await assert.rejects(store.appendChunk('c', 4096, brokenStream(chunks[1]), MAX), /끊겼습니다/);
    // 한도를 넘는 조각도 실패 경로다.
    await assert.rejects(store.appendChunk('c', 4096, Readable.from([chunks[1]]), 100), /조각이 너무 큽니다/);
    assert.equal(store.trackedSessions, 1);
    await sendAll(store, 'c', 1);
    const done = await store.completeSession('c', data.length);
    assert.deepEqual(done, { hash: sha256(data), size: data.length, rehashed: false });
  });

  it('서버를 다시 켜면(새 인스턴스) 이어 계산이 없어 전체를 다시 읽고, 해시는 같다', async () => {
    await store.createSession('d');
    await sendAll(store, 'd');
    const restarted = new BlobStore(root);
    const done = await restarted.completeSession('d', data.length);
    assert.deepEqual(done, { hash: sha256(data), size: data.length, rehashed: true });
    await store.removeSession('d');
  });

  it('이미 받은 앞쪽 offset 에서 다시 보내면 이어 계산을 버리고 complete 때 다시 읽는다', async () => {
    await store.createSession('e');
    await store.appendChunk('e', 0, Readable.from([chunks[0]]), MAX);
    await store.appendChunk('e', 4096, Readable.from([chunks[1]]), MAX);
    // 해시는 8192 까지인데 4096 부터 다시 — 파일은 잘라 다시 쓰지만 해시는 되감을 수 없다.
    await sendAll(store, 'e', 1);
    assert.equal(store.trackedSessions, 0);
    const done = await store.completeSession('e', data.length);
    assert.deepEqual(done, { hash: sha256(data), size: data.length, rehashed: true });
  });

  it('빈 파일도 이어 계산한 해시로 끝난다', async () => {
    await store.createSession('empty');
    const done = await store.completeSession('empty', 0);
    assert.deepEqual(done, { hash: sha256(Buffer.alloc(0)), size: 0, rehashed: false });
  });

  it('removeSession 뒤에는 이어 계산 항목이 남지 않는다', async () => {
    await store.createSession('f');
    await store.appendChunk('f', 0, Readable.from([chunks[0]]), MAX);
    assert.equal(store.trackedSessions, 1);
    await store.removeSession('f');
    assert.equal(store.trackedSessions, 0);
    assert.equal(fs.existsSync(path.join(root, 'tmp', 'session_f')), false);
  });
});
