import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { auth, createHarness, createRepo, signup, uploadFile, type Harness, type Session } from './helpers.ts';

describe('이력 커서 검사', () => {
  let h: Harness;
  let owner: Session;
  let repoId: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '커서 검사');
    const res = await uploadFile(h.app, owner, repoId, '파일.txt', '내용');
    assert.equal(res.statusCode, 201);
  });
  after(async () => {
    await h.close();
  });

  const urls = (query: string) => [
    `/api/repos/${repoId}/history?${query}`,
    `/api/repos/${repoId}/files/versions?path=${encodeURIComponent('파일.txt')}&${query}`,
  ];

  async function status(url: string): Promise<number> {
    const res = await h.app.inject({ method: 'GET', url, headers: auth(owner) });
    return res.statusCode;
  }

  it('before 만 오면 첫 페이지를 다시 주지 않고 400 이다', async () => {
    for (const url of urls('before=123')) assert.equal(await status(url), 400, url);
  });

  it('beforeId 만 오거나 before 가 숫자가 아니어도 400 이다', async () => {
    for (const query of ['beforeId=abc', 'before=abc&beforeId=abc', 'before=&beforeId=abc']) {
      for (const url of urls(query)) assert.equal(await status(url), 400, url);
    }
  });

  it('커서가 없거나 둘 다 올바르면 통과한다', async () => {
    for (const query of ['', 'before=9999999999999&beforeId=zzz']) {
      for (const url of urls(query)) assert.equal(await status(url), 200, url);
    }
  });
});
