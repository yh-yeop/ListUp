import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serverUrlCandidates } from '../src/lib/pure/server-url';

describe('serverUrlCandidates', () => {
  it('http(s):// 를 적었으면 그것만', () => {
    assert.deepEqual(serverUrlCandidates(' https://listup.example.com/ '), ['https://listup.example.com']);
    assert.deepEqual(serverUrlCandidates('http://192.168.0.10:4000'), ['http://192.168.0.10:4000']);
  });

  it('공유기 안 주소만 적으면 기본 포트 4000 을 먼저', () => {
    assert.deepEqual(serverUrlCandidates('192.168.0.10'), ['http://192.168.0.10:4000', 'http://192.168.0.10']);
    assert.deepEqual(serverUrlCandidates('localhost'), ['http://localhost:4000', 'http://localhost']);
  });

  it('포트를 적으면 그 포트로, 공유기 안이면 http 먼저', () => {
    assert.deepEqual(serverUrlCandidates('192.168.0.10:5000'), ['http://192.168.0.10:5000', 'https://192.168.0.10:5000']);
    assert.deepEqual(serverUrlCandidates('files.example.com:8443'), ['https://files.example.com:8443', 'http://files.example.com:8443']);
  });

  it('이름 있는 주소는 https 먼저', () => {
    assert.deepEqual(serverUrlCandidates('listup.example.com'), [
      'https://listup.example.com',
      'http://listup.example.com:4000',
      'http://listup.example.com',
    ]);
  });

  it('주소가 아니면 후보가 없다', () => {
    assert.deepEqual(serverUrlCandidates(''), []);
    assert.deepEqual(serverUrlCandidates('우리 집 서버'), []);
    assert.deepEqual(serverUrlCandidates('ftp://x'), []);
  });
});
