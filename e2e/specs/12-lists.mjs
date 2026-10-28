import { api, screen } from '../lib.mjs';

export const title = '목록 — 저장소 찾기·제안 더 보기';

export default async function run(t, env) {
  const { A } = env;
  const reg = (await api(A, '/api/auth/signup', { email: `ls-${env.run}@a.test`, password: 'password-1', displayName: 'ls' })).json;
  const { token } = reg;
  const makeRepo = async (name, description) => (await api(A, '/api/repos', { name, description }, token)).json.repo;

  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const s = screen(page);
  await page.goto(A + '/api/health');
  await page.evaluate(
    ({ token, user }) =>
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
      ),
    { token, user: reg.user },
  );

  // 저장소 찾기 — 몇 개뿐이면 칸이 없고, 5개부터 보인다.
  for (const [name, description] of [['동아리 사진', '봄 MT'], ['음악', '집 서버 노래'], ['회의록', '동아리 운영 회의'], ['Backup', '']]) {
    await makeRepo(name, description);
  }
  await page.goto(A + '/');
  await s.onRepos('ls').waitFor();
  await page.getByText('회의록', { exact: true }).waitFor();
  t.must((await page.getByLabel('저장소 찾기').count()) === 0, '저장소 4개 — 찾기 칸이 없다');

  await makeRepo('잡동사니', '');
  await page.reload();
  const search = page.getByLabel('저장소 찾기').filter({ visible: true });
  await search.waitFor();
  t.ok('저장소 5개 — 찾기 칸이 보인다');

  const visible = (name) => page.getByText(name, { exact: true }).filter({ visible: true });
  await search.fill('동아리');
  await visible('음악').waitFor({ state: 'hidden' });
  const top = async (name) => (await visible(name).boundingBox())?.y ?? Number.NaN;
  t.must((await top('동아리 사진')) < (await top('회의록')), '이름에서 찾은 것("동아리 사진")이 설명에서만 찾은 것("회의록")보다 위');
  t.must((await visible('Backup').count()) === 0, '맞지 않는 저장소는 숨긴다');
  await search.fill('backup');
  await visible('Backup').waitFor();
  t.ok('대소문자를 가리지 않는다');
  await search.fill('없는낱말');
  await page.getByText('찾는 저장소가 없습니다').waitFor();
  t.ok('없으면 없다고');
  await search.fill('');
  await visible('음악').waitFor();
  t.ok('지우면 다시 전부');

  // 제안 더 보기 — 한 번에 30개, 나머지는 '더 보기' 로.
  const repo = await makeRepo('제안 많음', '');
  const bytes = Buffer.from('x');
  const { upload } = (await api(A, `/api/repos/${repo.id}/uploads`, { name: 'x.txt', size: bytes.length }, token)).json;
  await fetch(`${A}/api/uploads/${upload.id}?offset=0`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const { blob } = (await api(A, `/api/uploads/${upload.id}/complete`, {}, token)).json;
  for (let i = 1; i <= 32; i++) {
    const n = String(i).padStart(2, '0');
    const res = await api(A, `/api/repos/${repo.id}/proposals`, { title: `제안 ${n}`, changes: [{ path: `p${n}.txt`, blobHash: blob.hash }] }, token);
    if (res.status !== 201) throw new Error(`제안을 만들지 못했습니다 (${res.status}): ${JSON.stringify(res.json)}`);
  }

  await page.goto(`${A}/repo/${repo.id}/proposals`);
  await visible('제안 32').waitFor();
  t.must((await visible('제안 03').count()) === 1 && (await visible('제안 02').count()) === 0, '처음에는 최근 30개(#32~#3)');
  const more = page.getByRole('button', { name: '더 보기' }).filter({ visible: true });
  await more.click();
  await visible('제안 01').waitFor();
  t.must((await visible('제안 02').count()) === 1, '더 보기 → 나머지 #2·#1');
  await more.waitFor({ state: 'hidden' });
  t.ok('다 받으면 더 보기가 사라진다');

  await ctx.close();
}
