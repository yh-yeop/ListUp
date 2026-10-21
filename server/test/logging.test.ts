import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { logSerializers, maskUrl } from '../src/start.ts';
import { auth, createHarness, createInvite, createRepo, signup, uploadFile, type Harness, type Session } from './helpers.ts';

describe('maskUrl', () => {
  it('초대 코드와 다운로드 토큰을 가리고, 다른 쿼리는 그대로 둔다', () => {
    assert.equal(maskUrl('/api/invites/ABCDE-12345'), '/api/invites/***');
    assert.equal(maskUrl('/api/invites/ABCDE-12345/accept'), '/api/invites/***/accept');
    assert.equal(maskUrl('/api/dl?t=eyJ1Ijo.c2lnbg'), '/api/dl?t=***');
    assert.equal(maskUrl('/api/dl?x=1&t=abc#frag'), '/api/dl?x=1&t=***#frag');
    const plain = '/api/repos/r1/raw?path=%EB%AC%B8%EC%84%9C&at=1&snapshot=s1';
    assert.equal(maskUrl(plain), plain);
  });
});

/** PC 앱은 서버 로그(pino JSON 줄)를 파일로 남긴다 — 실제 요청 로그에 비밀이 실리지 않는지 본다. */
describe('요청 로그 직렬화', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;
  const lines: string[] = [];

  before(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    h = await createHarness({}, { logger: { level: 'info', stream, serializers: logSerializers } });
    owner = await signup(h.app, '주인');
    repoId = await createRepo(h.app, owner, '로그');
    await uploadFile(h.app, owner, repoId, 'a.txt', 'hello');
  });
  after(async () => {
    await h.close();
  });

  it('다운로드 링크 토큰과 초대 코드가 로그에 남지 않는다', async () => {
    const link = await h.app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/download-link`,
      headers: auth(owner),
      payload: { path: 'a.txt' },
    });
    const { url } = link.json() as { url: string };
    const token = new URL(url, 'http://x').searchParams.get('t')!;
    assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 200);
    const invite = await createInvite(h.app, owner, repoId);
    await h.app.inject({ method: 'GET', url: `/api/invites/${invite.code}` });

    const logged = lines.join('\n');
    assert.ok(!logged.includes(token), '다운로드 토큰이 로그에 없다');
    assert.ok(!logged.includes(invite.code), '초대 코드가 로그에 없다');
    const urls = lines.map((line) => (JSON.parse(line) as { req?: { url?: string } }).req?.url).filter(Boolean);
    assert.ok(urls.includes('/api/dl?t=***'), '가린 다운로드 경로는 남는다');
    assert.ok(urls.includes('/api/invites/***'), '가린 초대 경로는 남는다');
  });
});

/** 요청 id 는 로그의 reqId 이자 500 의 requestId — 앱 화면의 "오류 번호"로 server.log 에서 찾는다. */
describe('요청 id', () => {
  let h: Harness;
  const lines: string[] = [];
  /** 이 인스턴스가 낸 번호 전부 — 새 인스턴스(재시작)의 번호와 겹치는지 본다. */
  const seen = new Set<string>();

  before(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    h = await createHarness(
      {},
      {
        logger: { level: 'info', stream, serializers: logSerializers },
        beforeReady(app) {
          app.get('/api/test-boom', async () => {
            throw new Error('일부러');
          });
        },
      },
    );
  });
  after(async () => {
    await h.close();
  });

  it('500 의 requestId 가 로그의 reqId 와 같고, 카운터가 아닌 무작위 id 다', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/test-boom' });
    assert.equal(res.statusCode, 500);
    const { requestId } = res.json() as { requestId: string };
    seen.add(requestId);
    assert.match(requestId, /^[0-9a-f]{10}$/);
    const logged = lines.map((line) => JSON.parse(line) as { reqId?: string; msg?: string });
    assert.ok(
      logged.some((entry) => entry.reqId === requestId && entry.msg === 'unhandled error'),
      '같은 번호로 오류 줄을 찾을 수 있다',
    );
  });

  it('요청마다 다르고, 서버를 새로 만들어도 처음부터 다시 매기지 않는다', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const res = await h.app.inject({ method: 'GET', url: '/api/test-boom' });
      ids.add((res.json() as { requestId: string }).requestId);
    }
    assert.equal(ids.size, 20);
    for (const id of ids) seen.add(id);
    // 재시작에 해당 — 새 인스턴스의 첫 요청이 앞 인스턴스의 번호와 겹치지 않는다(fastify 기본은 둘 다 req-1).
    const fresh = await createHarness(
      {},
      {
        beforeReady(app) {
          app.get('/api/test-boom', async () => {
            throw new Error('일부러');
          });
        },
      },
    );
    try {
      const res = await fresh.app.inject({ method: 'GET', url: '/api/test-boom' });
      assert.ok(!seen.has((res.json() as { requestId: string }).requestId));
    } finally {
      await fresh.close();
    }
  });

  it('요청 헤더로 보낸 id 는 쓰지 않는다', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/test-boom',
      headers: { 'request-id': 'forged-id', 'x-request-id': 'forged-id' },
    });
    const { requestId } = res.json() as { requestId: string };
    assert.notEqual(requestId, 'forged-id');
    assert.match(requestId, /^[0-9a-f]{10}$/);
  });
});
