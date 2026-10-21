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
