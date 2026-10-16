import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { API_LEVEL, API_VERSION } from '@listup/shared';
import { checkServer, describeCheck, normalizeServerUrl } from '../src/state/servers';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** /api/health 가 body 를 돌려주는 가짜 서버. */
function serve(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

const health = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  time: 0,
  maxUploadBytes: 1,
  apiVersion: API_VERSION,
  apiLevel: API_LEVEL,
  version: '1.4.0',
  ...extra,
});

describe('서버 주소', () => {
  it('http(s) 로 시작하는 주소만 받고 끝 / 를 뗀다', () => {
    assert.equal(normalizeServerUrl('  https://listup.example.com/// '), 'https://listup.example.com');
    assert.equal(normalizeServerUrl('http://192.168.0.10:4000'), 'http://192.168.0.10:4000');
    assert.equal(normalizeServerUrl('listup.example.com'), null);
    assert.equal(normalizeServerUrl('https://a b.com'), null);
  });
});

describe('연결 확인', () => {
  it('들어갈 수 있으면 버전과 서버 이름을 알려준다', async () => {
    serve(health({ serverName: '  우리집 서버 ' }));
    assert.deepEqual(await checkServer('http://s'), { status: 'ok', version: '1.4.0', name: '우리집 서버' });
  });

  it('이름이 없는 서버(1.3.0 까지)나 빈 이름은 null', async () => {
    serve(health());
    assert.equal(((await checkServer('http://s')) as { name: string | null }).name, null);
    serve(health({ serverName: '   ' }));
    assert.equal(((await checkServer('http://s')) as { name: string | null }).name, null);
  });

  it('API 버전이 다르면 어느 쪽이 오래됐는지 가른다', async () => {
    serve(health({ apiVersion: API_VERSION + 1 }));
    assert.equal((await checkServer('http://s')).status, 'app-older');
    serve(health({ apiVersion: API_VERSION - 1 }));
    assert.equal((await checkServer('http://s')).status, 'server-older');
  });

  it('필드가 없는 옛 서버는 버전 1·수준 1 로 본다 — 이 앱으로는 못 들어간다', async () => {
    serve({ ok: true, time: 0, maxUploadBytes: 1 });
    assert.equal((await checkServer('http://s')).status, 'server-older');
  });

  it('닿지 않거나 ListUp 이 아니면 unreachable', async () => {
    serve({ hello: 'world' });
    assert.equal((await checkServer('http://s')).status, 'unreachable');
    serve({}, 502);
    assert.equal((await checkServer('http://s')).status, 'unreachable');
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    assert.equal((await checkServer('http://s')).status, 'unreachable');
  });

  it('들어갈 수 있으면 설명이 없고, 아니면 이유를 사람 말로', () => {
    assert.equal(describeCheck({ status: 'ok', version: null, name: null }, 'http://s'), null);
    assert.match(describeCheck({ status: 'app-older', version: '9.0.0' }, 'http://s')!, /앱을 업데이트/);
  });
});
