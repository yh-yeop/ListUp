import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SESSIONS,
  SESSION_TTL_MS,
  forgetSession,
  lookupSession,
  parseSessions,
  pruneSessions,
  rememberSession,
  sessionKey,
  type SessionMemo,
  type SessionSource,
} from '../src/lib/pure/upload-sessions';

const BASE = 'https://listup.example';
const file = (over: Partial<SessionSource> = {}): SessionSource => ({
  name: 'x.txt',
  size: 100,
  relativePath: 'a/x.txt',
  lastModified: 1_700_000_000_000,
  ...over,
});

describe('sessionKey', () => {
  it('서버·저장소·경로·크기·고친 시각이 모두 들어간다', () => {
    const key = sessionKey(BASE, 'repo1', file());
    assert.equal(key, `${BASE}\nrepo1\na/x.txt\n100\n1700000000000`);
  });

  it('하나라도 다르면 다른 키', () => {
    const key = sessionKey(BASE, 'repo1', file());
    assert.notEqual(sessionKey('https://other.example', 'repo1', file()), key);
    assert.notEqual(sessionKey(BASE, 'repo2', file()), key);
    assert.notEqual(sessionKey(BASE, 'repo1', file({ relativePath: 'a/y.txt' })), key);
    assert.notEqual(sessionKey(BASE, 'repo1', file({ size: 101 })), key);
    assert.notEqual(sessionKey(BASE, 'repo1', file({ lastModified: 1_700_000_000_001 })), key);
  });

  it('폴더 안의 같은 이름 파일(a/x.txt 와 b/x.txt)은 크기·시각이 같아도 다르다', () => {
    assert.notEqual(
      sessionKey(BASE, 'repo1', file({ relativePath: 'a/x.txt' })),
      sessionKey(BASE, 'repo1', file({ relativePath: 'b/x.txt' })),
    );
  });

  it('폴더 경로가 없으면 이름으로', () => {
    assert.equal(sessionKey(BASE, 'r', file({ relativePath: undefined })), `${BASE}\nr\nx.txt\n100\n1700000000000`);
  });

  it('고친 시각이 없거나 0 이면 키가 없다 — 기억하지도 이어 가지도 않는다', () => {
    assert.equal(sessionKey(BASE, 'r', file({ lastModified: undefined })), null);
    assert.equal(sessionKey(BASE, 'r', file({ lastModified: 0 })), null);
    assert.equal(sessionKey(BASE, 'r', file({ lastModified: Number.NaN })), null);
  });

  it('경로는 NFC 로 — 맥(NFD)에서 고른 한글 이름도 같은 키', () => {
    const nfd = '사진/여름.txt'.normalize('NFD');
    assert.equal(
      sessionKey(BASE, 'r', file({ relativePath: nfd })),
      sessionKey(BASE, 'r', file({ relativePath: '사진/여름.txt'.normalize('NFC') })),
    );
  });
});

describe('기억하기·잊기', () => {
  const now = 10 * SESSION_TTL_MS;

  it('기억한 세션을 찾고, 잊으면 없다', () => {
    let memo: SessionMemo = {};
    memo = rememberSession(memo, 'k1', 'up_1', now);
    assert.equal(lookupSession(memo, 'k1', now), 'up_1');
    assert.equal(lookupSession(memo, 'k2', now), null);
    memo = forgetSession(memo, 'k1');
    assert.equal(lookupSession(memo, 'k1', now), null);
  });

  it('같은 키를 다시 기억하면 새 세션으로 바뀐다', () => {
    const memo = rememberSession(rememberSession({}, 'k', 'up_old', now - 1000), 'k', 'up_new', now);
    assert.equal(lookupSession(memo, 'k', now), 'up_new');
  });

  it('저장한 글로 오가도 그대로', () => {
    const memo = rememberSession({}, `${BASE}\nr\na/x.txt\n1\n2`, 'up_1', now);
    assert.deepEqual(parseSessions(JSON.stringify(memo)), memo);
  });

  it('깨진 글·모양이 다른 항목은 버린다', () => {
    assert.deepEqual(parseSessions(null), {});
    assert.deepEqual(parseSessions('{'), {});
    assert.deepEqual(parseSessions('[1]'), {});
    assert.deepEqual(parseSessions(JSON.stringify({ a: { uploadId: 'up', at: 1 }, b: { uploadId: 3 }, c: null })), {
      a: { uploadId: 'up', at: 1 },
    });
  });

  it('20시간이 지나면 잊는다', () => {
    const memo: SessionMemo = {
      old: { uploadId: 'up_old', at: now - SESSION_TTL_MS },
      fresh: { uploadId: 'up_fresh', at: now - SESSION_TTL_MS + 1 },
    };
    assert.deepEqual(Object.keys(pruneSessions(memo, now)), ['fresh']);
    assert.equal(lookupSession(memo, 'old', now), null);
    assert.equal(lookupSession(memo, 'fresh', now), 'up_fresh');
  });

  it('200개가 넘으면 오래된 것부터 잊는다', () => {
    let memo: SessionMemo = {};
    for (let i = 0; i < MAX_SESSIONS + 5; i += 1) memo = rememberSession(memo, `k${i}`, `up_${i}`, now - 1000 + i);
    assert.equal(Object.keys(memo).length, MAX_SESSIONS);
    assert.equal(lookupSession(memo, 'k0', now), null);
    assert.equal(lookupSession(memo, 'k4', now), null);
    assert.equal(lookupSession(memo, 'k5', now), 'up_5');
    assert.equal(lookupSession(memo, `k${MAX_SESSIONS + 4}`, now), `up_${MAX_SESSIONS + 4}`);
  });
});
