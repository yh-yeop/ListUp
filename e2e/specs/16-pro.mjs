import { api } from '../lib.mjs';

export const title = '익숙한 사람 — 정렬·폴더 주소·경로 복사·키보드 단축키';

export default async function run(t, env) {
  const { A } = env;
  const owner = (await api(A, '/api/auth/signup', { username: `pro-${env.run}`, password: 'password-1', displayName: '숙련자' })).json;
  const repo = (await api(A, '/api/repos', { name: '정렬' }, owner.token)).json.repo;
  const auth = { Authorization: `Bearer ${owner.token}` };
  async function put(filePath, content) {
    const bytes = Buffer.from(content);
    const { upload } = (await api(A, `/api/repos/${repo.id}/uploads`, { name: filePath.split('/').pop(), size: bytes.length }, owner.token)).json;
    await fetch(`${A}/api/uploads/${upload.id}?offset=0`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const { blob } = (await api(A, `/api/uploads/${upload.id}/complete`, {}, owner.token)).json;
    await api(A, `/api/repos/${repo.id}/files/commit`, { changes: [{ path: filePath, blobHash: blob.hash }] }, owner.token);
  }
  await put('a.txt', 'x'.repeat(10));
  await put('b.txt', 'x'.repeat(100));
  await put('c.txt', 'x');
  await put('폴더/안쪽.txt', '안');

  const ctx = await env.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(A + '/api/health');
  await page.evaluate(
    ({ token, user }) =>
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
      ),
    { token: owner.token, user: owner.user },
  );
  const order = async () =>
    (await page.getByText(/^[abc]\.txt$/).filter({ visible: true }).allInnerTexts()).map((x) => x.trim()).join(',');

  await page.goto(`${A}/repo/${repo.id}`);
  await page.getByRole('button', { name: '이름순 정렬', exact: false }).waitFor();
  t.must((await order()) === 'a.txt,b.txt,c.txt', '처음은 이름순');

  await page.getByRole('button', { name: '크기순 정렬' }).click();
  await page.waitForFunction(() => document.body.innerText.indexOf('b.txt') < document.body.innerText.indexOf('a.txt'));
  t.must((await order()) === 'b.txt,a.txt,c.txt', `크기순은 큰 것부터 (${await order()})`);
  await page.getByRole('button', { name: '크기순 정렬', exact: false }).click();
  await page.getByRole('button', { name: '크기순 정렬, 지금 작은 것부터' }).waitFor();
  t.must((await order()) === 'c.txt,a.txt,b.txt', '한 번 더 누르면 작은 것부터');
  t.must((await page.getByText('폴더', { exact: true }).count()) > 0, '폴더는 그대로 위에');

  await page.reload();
  await page.getByRole('button', { name: '크기순 정렬, 지금 작은 것부터' }).waitFor();
  t.must((await order()) === 'c.txt,a.txt,b.txt', '정렬은 기기에 기억된다 (새로고침 뒤에도)');

  // ── 폴더 주소 ───────────────────────────────────────────
  await page.getByRole('button', { name: '폴더 폴더 열기' }).click();
  await page.getByText('안쪽.txt', { exact: true }).waitFor();
  await page.waitForURL((url) => url.searchParams.get('path') === '폴더');
  t.ok('폴더를 열면 주소에 ?path= 가 남는다');
  await page.reload();
  await page.getByText('안쪽.txt', { exact: true }).waitFor();
  t.ok('새로고침해도 같은 폴더 (주소로 공유·북마크 가능)');

  // ── 경로 복사 ───────────────────────────────────────────
  await page.getByRole('button', { name: '안쪽.txt 더보기' }).click();
  await page.getByRole('button', { name: '안쪽.txt 경로 복사' }).click();
  await page.getByText('경로를 복사했습니다.').waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  t.must(copied === '폴더/안쪽.txt', `⋯ → 경로 복사 (${copied})`);

  // ── 키보드 단축키 ───────────────────────────────────────
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Backspace');
  await page.getByText('a.txt', { exact: true }).filter({ visible: true }).waitFor();
  t.must(new URL(page.url()).searchParams.get('path') === null, 'Backspace → 위 폴더 (주소의 path 도 지워짐)');

  await page.keyboard.press('/');
  t.must(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '파일 찾기'),
    '/ → 파일 찾기 칸으로',
  );
  await page.keyboard.type('안쪽');
  await page.getByText('안쪽.txt', { exact: false }).filter({ visible: true }).first().waitFor();
  await page.keyboard.press('Backspace');
  t.must((await page.getByLabel('파일 찾기').filter({ visible: true }).inputValue()) === '안', '칸 안의 Backspace 는 글자만 지운다');
  await page.keyboard.press('Escape');
  await page.getByText('a.txt', { exact: true }).filter({ visible: true }).waitFor();
  t.must((await page.getByLabel('파일 찾기').filter({ visible: true }).inputValue()) === '', 'Esc → 찾기 지우고 목록으로');

  t.must(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label') !== '파일 찾기'),
    'Esc 뒤에는 칸에서 빠진다 (다음 키가 글자로 들어가지 않게)',
  );
  await page.keyboard.press('Shift+Slash');
  await page.getByText('키보드 단축키 (웹·PC 앱)').waitFor();
  t.ok('? → 사용법(단축키 목록)');
  await ctx.close();
}
