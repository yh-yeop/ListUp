import { api } from '../lib.mjs';

export const title = '익숙한 사람 — 정렬·폴더 주소·경로 복사·키보드 단축키·여러 개 지우기·옮기기·되돌리기';

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
  await put('폴더/b.txt', '겹침');

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

  // ── 새로고침이 잠깐 실패해도 보던 목록은 그대로 (REFACTOR U2-12) ──
  await page.goto(`${A}/repo/${repo.id}`);
  await page.getByRole('button', { name: 'a.txt 내려받기' }).first().waitFor();
  const listCall = (url) => url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/files');
  await page.route(listCall, (route) => route.abort('internetdisconnected'));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await page.getByText('새로 고치지 못했습니다 — 보던 목록을 그대로 둡니다.').waitFor();
  t.must(await page.getByRole('button', { name: 'a.txt 내려받기' }).first().isVisible(), '연결이 끊겨 새로고침이 실패해도 목록이 남는다');
  const failedToast = page.getByRole('alert').filter({ hasText: '새로 고치지 못했습니다' });
  await failedToast.getByRole('button', { name: '연결 문제 해결' }).waitFor();
  t.ok('연결 실패 토스트에 「연결 문제 해결」 버튼');
  await page.unroute(listCall);

  // ── 여러 개 골라 지우기 ──────────────────────────────────
  await page.goto(`${A}/repo/${repo.id}`);
  await page.getByRole('button', { name: '여러 개 고르기' }).click();
  await page.getByText('받거나 지울 파일을 누르세요').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '여러 개 고르기' }).waitFor();
  t.ok('Esc → 고르기 끝');
  await page.getByRole('button', { name: '여러 개 고르기' }).click();
  await page.getByRole('checkbox', { name: 'a.txt 고르기' }).click();
  await page.getByRole('checkbox', { name: 'c.txt 고르기' }).click();
  await page.getByText('2개 고름').waitFor();
  t.must((await page.getByRole('checkbox', { name: 'a.txt 고르기' }).getAttribute('aria-checked')) === 'true', '고른 줄은 체크 상태');
  await page.getByRole('button', { name: '고른 파일 2개 지우기' }).click();
  await page.getByText('2개를 지웠습니다.').waitFor();
  await page.getByRole('button', { name: 'b.txt 내려받기' }).first().waitFor();
  t.must((await page.getByText(/^[ac]\.txt$/).filter({ visible: true }).count()) === 0, '고른 2개만 사라지고 고르기도 끝');
  const history = (await api(A, `/api/repos/${repo.id}/history`, undefined, owner.token)).json;
  const latest = (history.snapshots ?? history.history ?? [])[0];
  t.must(latest?.message === '파일 2개 삭제', `변경 이력에 커밋 하나로 (${latest?.message})`);

  // ── 여러 개 골라 옮기기 ──────────────────────────────────
  await put('d.txt', 'd');
  await page.reload();
  await page.getByRole('button', { name: '여러 개 고르기' }).click();
  await page.getByRole('checkbox', { name: 'b.txt 고르기' }).click();
  await page.getByRole('checkbox', { name: 'd.txt 고르기' }).click();
  await page.getByRole('button', { name: '고른 파일 2개 옮기기' }).click();
  await page.getByLabel('옮길 폴더').fill('폴더');
  await page.getByRole('button', { name: '여기로 옮기기' }).click();
  await page.getByText('같은 이름이 있어 옮기지 않았습니다', { exact: false }).waitFor();
  t.must((await api(A, `/api/repos/${repo.id}/files?path=`, undefined, owner.token)).json.tree.files.length === 2, '옮길 폴더에 같은 이름(b.txt)이 있으면 아무것도 옮기지 않는다 (덮어쓰지 않음)');
  await page.getByLabel('옮길 폴더').fill('보관/2026');
  await page.getByRole('button', { name: '여기로 옮기기' }).click();
  await page.getByText('2개를 보관/2026(으)로 옮겼습니다.').waitFor();
  const moved = (await api(A, `/api/repos/${repo.id}/files?path=${encodeURIComponent('보관/2026')}`, undefined, owner.token)).json.tree.files;
  t.must(moved.map((f) => f.name).sort().join(',') === 'b.txt,d.txt', '없는 폴더면 새로 만들어 옮긴다');
  const afterMove = (await api(A, `/api/repos/${repo.id}/history`, undefined, owner.token)).json.snapshots[0];
  t.must(afterMove.message === '파일 2개를 보관/2026(으)로 옮김', '이력에 한 번으로');

  // ── 방금 한 일 되돌리기 (토스트의 「되돌리기」) ──────────────
  await page.getByRole('button', { name: '되돌리기' }).click();
  await page.getByText('되돌렸습니다.').waitFor();
  const back = (await api(A, `/api/repos/${repo.id}/files?path=`, undefined, owner.token)).json.tree.files.map((f) => f.name).sort();
  t.must(back.join(',') === 'b.txt,d.txt', `옮기기 되돌리기 → 제자리 (${back.join(',')})`);
  const undone = (await api(A, `/api/repos/${repo.id}/history`, undefined, owner.token)).json.snapshots[0];
  t.must(undone.message === '되돌리기: 파일 2개를 보관/2026(으)로 옮김', `되돌리기도 커밋 하나 (${undone.message})`);
  await page.getByRole('button', { name: 'd.txt 내려받기' }).first().waitFor();

  // 지우기 되돌리기 — 그 사이 같은 이름이 생겼으면 덮지 않는다(409).
  await page.getByRole('button', { name: '여러 개 고르기' }).click();
  await page.getByRole('checkbox', { name: 'd.txt 고르기' }).click();
  await page.getByRole('button', { name: '고른 파일 1개 지우기' }).click();
  await page.getByText('1개를 지웠습니다.').waitFor();
  await put('d.txt', '다른 사람이 새로 올림');
  await page.getByRole('button', { name: '되돌리기' }).click();
  await page.getByText('그 사이 바뀐 파일이 있어 되돌리지 않았습니다.').waitFor();
  const kept = (await api(A, `/api/repos/${repo.id}/history`, undefined, owner.token)).json.snapshots[0];
  t.must(!kept.message.startsWith('되돌리기'), '그 사이 바뀌었으면 되돌리지 않는다 (남의 새 파일을 덮지 않음)');

  // 이름 변경으로 다른 폴더에 옮기면 어디로 갔는지 알리고 되돌릴 수 있다 (예전엔 말없이 목록에서 사라졌다).
  await page.reload();
  await page.getByRole('button', { name: 'b.txt 더보기' }).first().click();
  await page.getByRole('button', { name: 'b.txt 이름 변경' }).click();
  await page.getByLabel('새 경로').fill('보관/b.txt');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByText('b.txt → 보관/b.txt').waitFor();
  t.ok('다른 폴더로 옮기면 「옮겼습니다 — b.txt → 보관/b.txt」');
  await page.getByRole('button', { name: '되돌리기' }).click();
  await page.getByText('되돌렸습니다.').waitFor();
  const root = (await api(A, `/api/repos/${repo.id}/files?path=`, undefined, owner.token)).json.tree.files.map((f) => f.name);
  t.must(root.includes('b.txt'), '되돌리기 → 다시 맨 위에');

  // 찾기 결과에서 「있는 폴더 열기」 → 그 폴더에서 찾은 파일 줄을 잠시 칠한다.
  await page.getByLabel('파일 찾기').fill('안쪽');
  await page.getByRole('button', { name: '안쪽.txt 이(가) 있는 폴더 열기' }).click();
  await page.waitForURL((url) => url.searchParams.get('path') === '폴더');
  const row = page.getByRole('button', { name: '안쪽.txt 내려받기' }).first();
  await row.waitFor();
  const paint = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const other = await page.getByRole('button', { name: 'b.txt 내려받기' }).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  t.must(paint !== other, `찾은 파일 줄을 칠해 보인다 (${paint} vs ${other})`);

  // 폴더 지우기도 되돌릴 수 있다 — 안의 파일을 읽은 내용대로 지우는 커밋 하나.
  await page.goto(`${A}/repo/${repo.id}`);
  await page.getByRole('button', { name: '폴더 폴더 더보기' }).click();
  await page.getByRole('button', { name: '폴더 폴더 삭제' }).click();
  await page.getByText('폴더를 지웠습니다 (파일 2개).').waitFor();
  const gone = (await api(A, `/api/repos/${repo.id}/files?path=`, undefined, owner.token)).json.tree.dirs.map((d) => d.name);
  t.must(!gone.includes('폴더'), '폴더 삭제');
  await page.getByRole('button', { name: '되돌리기' }).click();
  await page.getByText('되돌렸습니다.').waitFor();
  const inner = (await api(A, `/api/repos/${repo.id}/files?path=${encodeURIComponent('폴더')}`, undefined, owner.token)).json.tree.files.map((f) => f.name).sort();
  t.must(inner.join(',') === 'b.txt,안쪽.txt', `폴더 지우기 되돌리기 → 안의 파일이 그대로 (${inner.join(',')})`);
  await ctx.close();
}
