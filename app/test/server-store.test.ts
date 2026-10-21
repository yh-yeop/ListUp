import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SERVER_ID,
  LEGACY_KEYS,
  readStore,
  storeFromLegacy,
  type LegacyContext,
} from '../src/lib/pure/server-store';

const DEFAULT_URL = 'http://192.168.0.10:4000';
const NOW = 1_700_000_000_000;
const USER = { id: 'u1', username: 'kim', displayName: '김' };

function context(isClient: boolean): LegacyContext {
  return { isClient, defaultUrl: DEFAULT_URL, newId: () => 'srv_new', now: NOW };
}

/** 예전 키 셋 — 넘기지 않은 키는 저장돼 있지 않은 것(multiGet 이 null 을 준다). */
function legacy(values: { apiUrl?: string; token?: string; user?: string }): Record<string, string | null> {
  return {
    [LEGACY_KEYS.apiUrl]: values.apiUrl ?? null,
    [LEGACY_KEYS.token]: values.token ?? null,
    [LEGACY_KEYS.user]: values.user ?? null,
  };
}

describe('storeFromLegacy — 서버 목록 이전의 키만 있을 때', () => {
  it('주소를 바꾼 적 없으면 기본 서버에 토큰·사용자를 넣는다 (로그아웃되지 않는다)', () => {
    const store = storeFromLegacy(legacy({ token: 't', user: JSON.stringify(USER) }), context(false));
    assert.equal(store.activeId, DEFAULT_SERVER_ID);
    assert.equal(store.servers.length, 1);
    assert.equal(store.servers[0].id, DEFAULT_SERVER_ID);
    assert.equal(store.servers[0].token, 't');
    assert.deepEqual(store.servers[0].user, USER);
  });

  it('기본 주소와 같은 주소(끝 슬래시만 다름)도 기본 서버로', () => {
    const store = storeFromLegacy(legacy({ apiUrl: `${DEFAULT_URL}//`, token: 't' }), context(false));
    assert.deepEqual(
      store.servers.map((entry) => entry.id),
      [DEFAULT_SERVER_ID],
    );
    assert.equal(store.servers[0].token, 't');
  });

  it('주소를 바꿨으면 그 주소의 항목을 만들어 지금 서버로 — 서버 모드는 기본 서버를 앞에 둔다', () => {
    const store = storeFromLegacy(
      legacy({ apiUrl: 'https://music.example.com/', token: 't', user: JSON.stringify(USER) }),
      context(false),
    );
    assert.equal(store.activeId, 'srv_new');
    assert.deepEqual(
      store.servers.map((entry) => [entry.id, entry.url, entry.token]),
      [
        [DEFAULT_SERVER_ID, '', null],
        ['srv_new', 'https://music.example.com', 't'],
      ],
    );
    assert.deepEqual(store.servers[1].user, USER);
    assert.equal(store.servers[1].lastUsedAt, NOW);
    assert.equal(store.servers[1].signedOut, false);
  });

  it('클라이언트 모드에는 기본 서버가 없다 — 바꾼 주소만 옮기고, 없으면 빈 목록', () => {
    const moved = storeFromLegacy(legacy({ apiUrl: 'https://music.example.com', token: 't' }), context(true));
    assert.equal(moved.activeId, 'srv_new');
    assert.deepEqual(
      moved.servers.map((entry) => entry.id),
      ['srv_new'],
    );
    assert.deepEqual(storeFromLegacy(legacy({ token: 't' }), context(true)), { version: 1, activeId: null, servers: [] });
  });

  it('토큰이 없으면 사용자도 버리고 마지막 사용 시각도 비운다', () => {
    const store = storeFromLegacy(
      legacy({ apiUrl: 'https://music.example.com', user: JSON.stringify(USER) }),
      context(false),
    );
    assert.equal(store.servers[1].token, null);
    assert.equal(store.servers[1].user, null);
    assert.equal(store.servers[1].lastUsedAt, null);
  });

  it('사용자 값이 깨졌으면 사용자만 버리고 토큰은 지킨다', () => {
    for (const user of ['{깨짐', '"문자열"', JSON.stringify({ username: 'id 없음' })]) {
      const store = storeFromLegacy(legacy({ token: 't', user }), context(false));
      assert.equal(store.servers[0].token, 't', user);
      assert.equal(store.servers[0].user, null, user);
    }
  });

  it('아무 키도 없으면 처음 켠 것과 같다', () => {
    const store = storeFromLegacy(legacy({}), context(false));
    assert.equal(store.activeId, DEFAULT_SERVER_ID);
    assert.equal(store.servers[0].token, null);
    assert.equal(store.servers[0].user, null);
  });
});

describe('readStore — 새 목록 키가 있을 때', () => {
  const custom = { id: 'srv_a', url: 'https://a.example.com', token: 't', user: USER, lastUsedAt: 1, signedOut: false };

  it('읽을 수 있으면 그대로 쓴다 — 예전 키가 함께 남아 있어도 옮기지 않는다(loadServers)', () => {
    const raw = JSON.stringify({ version: 1, activeId: 'srv_a', servers: [{ id: DEFAULT_SERVER_ID, url: '' }, custom] });
    const store = readStore(raw, false);
    assert.ok(store);
    assert.equal(store.activeId, 'srv_a');
    assert.deepEqual(
      store.servers.map((entry) => entry.id),
      [DEFAULT_SERVER_ID, 'srv_a'],
    );
    assert.deepEqual(store.servers[1].user, USER);
  });

  it('깨졌으면 null — 그러면 예전 키에서 다시 옮긴다', () => {
    for (const raw of ['', '{', 'null', '"x"', '{}', JSON.stringify({ servers: 'x' })]) {
      assert.equal(readStore(raw, false), null, raw);
    }
  });

  it('서버 모드: 기본 서버를 맨 앞에 두고(없으면 만든다), 목록 밖 activeId 는 기본 서버로', () => {
    const store = readStore(JSON.stringify({ activeId: 'srv_gone', servers: [custom] }), false);
    assert.ok(store);
    assert.equal(store.activeId, DEFAULT_SERVER_ID);
    assert.deepEqual(
      store.servers.map((entry) => entry.id),
      [DEFAULT_SERVER_ID, 'srv_a'],
    );
  });

  it('클라이언트 모드: 기본 서버를 빼고, 목록 밖 activeId 는 null', () => {
    const raw = JSON.stringify({ activeId: DEFAULT_SERVER_ID, servers: [{ id: DEFAULT_SERVER_ID, url: '' }, custom] });
    const store = readStore(raw, true);
    assert.ok(store);
    assert.equal(store.activeId, null);
    assert.deepEqual(
      store.servers.map((entry) => entry.id),
      ['srv_a'],
    );
  });

  it('같은 id 는 처음 것만, 모양이 틀린 항목은 버린다', () => {
    const raw = JSON.stringify({
      activeId: 'srv_a',
      servers: [custom, { ...custom, url: 'https://dup.example.com' }, { id: 'srv_b' }, null, 'x', { id: 3, url: '' }],
    });
    const store = readStore(raw, true);
    assert.ok(store);
    assert.deepEqual(
      store.servers.map((entry) => entry.url),
      ['https://a.example.com'],
    );
  });

  it('빈 문자열 이름·토큰은 없는 것으로', () => {
    const store = readStore(JSON.stringify({ activeId: 'srv_a', servers: [{ ...custom, label: '', token: '' }] }), true);
    assert.ok(store);
    assert.equal(store.servers[0].label, null);
    assert.equal(store.servers[0].token, null);
  });
});
