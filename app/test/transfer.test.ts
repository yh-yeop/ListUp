import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ApiError, api, type UploadSource } from '../src/api/client';
import { UploadAbortedError, uploadAndCommit, uploadMany, type UploadItem } from '../src/lib/transfer';

type Api = typeof api;
const original: Partial<Api> = {};
const CHUNK = 4;

/** 서버 흉내 — 세션별로 받은 바이트를 들고, 호출을 기록한다. */
let sessions: Map<string, { name: string; size: number; received: number }>;
let calls: string[];
let onPut: (id: string, offset: number) => Promise<void> | void;

function patch<K extends keyof Api>(key: K, value: Api[K]) {
  if (!(key in original)) original[key] = api[key] as never;
  api[key] = value;
}

beforeEach(() => {
  sessions = new Map();
  calls = [];
  onPut = () => {};
  let n = 0;
  const session = (id: string) => {
    const s = sessions.get(id)!;
    return { upload: { id, repoId: 'r', name: s.name, size: s.size, received: s.received, chunkSize: CHUNK } };
  };
  patch('startUpload', async (_repoId, { name, size }) => {
    const id = `u${++n}`;
    sessions.set(id, { name, size, received: 0 });
    calls.push(`start ${id}`);
    return session(id);
  });
  patch('getUpload', async (id) => session(id));
  patch('putChunk', async (id, offset, bytes, _progress, signal) => {
    await onPut(id, offset);
    if (signal?.aborted) throw new UploadAbortedError();
    const length = bytes instanceof Uint8Array ? bytes.byteLength : (bytes as Blob).size;
    sessions.get(id)!.received = offset + length;
    calls.push(`put ${id}@${offset}`);
    return session(id);
  });
  patch('completeUpload', async (id) => {
    calls.push(`complete ${id}`);
    const s = sessions.get(id)!;
    return { blob: { hash: `hash-${id}`, size: s.size, mimeType: 'text/plain', name: s.name } };
  });
  patch('cancelUpload', async (id) => {
    calls.push(`cancel ${id}`);
    return { ok: true as const };
  });
  patch('commitFiles', async (_repoId, files) => {
    calls.push(`commit ${files.length}`);
    return { snapshotId: 's', added: files.length, updated: 0, removed: 0, unchanged: false } as never;
  });
});

afterEach(() => {
  Object.assign(api, original);
});

const item = (name: string, text: string): UploadItem => {
  const file = new Blob([text]) as unknown as File;
  const source: UploadSource = { kind: 'web', file, name, size: text.length };
  return { source, path: name };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('나눠 올리기', () => {
  it('조각으로 보내고 다 올린 뒤 커밋 하나로', async () => {
    const result = await uploadAndCommit('r', [item('a.txt', 'abcdefghij'), item('b.txt', 'xy')], () => {});
    assert.equal(result.cancelled, false);
    assert.equal(result.uploaded.length, 2);
    assert.deepEqual(calls, [
      'start u1', 'put u1@0', 'put u1@4', 'put u1@8', 'complete u1',
      'start u2', 'put u2@0', 'complete u2',
      'commit 2',
    ]);
  });

  it('서버가 받은 위치를 알려 주면(409) 거기서 이어 보낸다', async () => {
    let refused = false;
    onPut = (id, offset) => {
      if (offset === 4 && !refused) {
        refused = true;
        sessions.get(id)!.received = 8; // 앞선 응답을 못 받았지만 서버는 이미 받음
        throw new ApiError(409, 'conflict', '위치가 다릅니다', { received: 8 });
      }
    };
    const result = await uploadMany('r', [item('a.txt', 'abcdefghij')], () => {});
    assert.equal(result.uploaded.length, 1);
    assert.ok(calls.includes('put u1@8'));
  });

  it('권한이 없으면 나머지도 같은 이유로 실패로 두고 멈춘다', async () => {
    onPut = () => {
      throw new ApiError(403, 'forbidden', '권한이 없습니다.');
    };
    const result = await uploadMany('r', [item('a', 'a'), item('b', 'b'), item('c', 'c')], () => {});
    assert.deepEqual(result.failures.map((f) => f.message), ['권한이 없습니다.', '권한 없음', '권한 없음']);
    assert.equal(calls.filter((c) => c.startsWith('start')).length, 1);
  });
});

describe('올리기 멈추기', () => {
  it('도중에 멈추면 커밋하지 않고, 남은 파일은 시작도 하지 않으며, 세션을 지운다', async () => {
    const controller = new AbortController();
    onPut = (_id, offset) => {
      if (offset === 4) controller.abort();
    };
    const result = await uploadAndCommit('r', [item('a.txt', 'abcdefghij'), item('b.txt', 'xy')], () => {}, controller.signal);
    await settle();
    assert.equal(result.cancelled, true);
    assert.equal(result.commit, null);
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.failures.length, 0, '멈춘 것은 실패로 세지 않는다');
    assert.ok(!calls.includes('start u2'));
    assert.ok(!calls.some((c) => c.startsWith('commit')));
    assert.ok(calls.includes('cancel u1'));
  });

  it('파일 사이에서 멈춰도 이미 올린 것을 커밋하지 않는다', async () => {
    const controller = new AbortController();
    const result = await uploadAndCommit(
      'r',
      [item('a', 'ab'), item('b', 'cd')],
      (progress) => {
        if (progress.doneFiles === 1) controller.abort();
      },
      controller.signal,
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.commit, null);
    assert.ok(!calls.some((c) => c.startsWith('commit')));
  });

  it('조각을 받는 중이라 지우기가 409 면 잠시 뒤 다시 지운다', async () => {
    let tries = 0;
    patch('cancelUpload', async (id) => {
      tries += 1;
      if (tries === 1) throw new ApiError(409, 'conflict', '받는 중');
      calls.push(`cancel ${id}`);
      return { ok: true as const };
    });
    const controller = new AbortController();
    controller.abort();
    onPut = () => {};
    const result = await uploadMany('r', [item('a', 'abcdef')], () => {}, controller.signal);
    assert.equal(result.cancelled, true);
    assert.equal(calls.length, 0, '이미 멈췄으면 세션도 만들지 않는다');

    const second = new AbortController();
    onPut = () => second.abort();
    await uploadMany('r', [item('a', 'abcdef')], () => {}, second.signal);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(tries, 2);
    assert.ok(calls.includes('cancel u1'));
  });
});
