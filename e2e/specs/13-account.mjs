import { api, screen } from '../lib.mjs';

export const title = '계정·협업 — 내 제안·닫는 이유·활동 기록·로그아웃';

export default async function run(t, env) {
  const { A } = env;
  const signup = async (who) =>
    (await api(A, '/api/auth/signup', { email: `ac-${who}-${env.run}@a.test`, password: 'password-1', displayName: who })).json;
  const owner = await signup('주인');
  const viewer = await signup('기여자');
  const repo = (await api(A, '/api/repos', { name: '보고서 모음' }, owner.token)).json.repo;
  const invite = (await api(A, `/api/repos/${repo.id}/invites`, { role: 'viewer' }, owner.token)).json.invite;
  await api(A, `/api/invites/${invite.code}/join`, {}, viewer.token);

  // 기여자가 제안 둘을 올려 둔다.
  const bytes = Buffer.from('새 내용');
  const { upload } = (await api(A, `/api/repos/${repo.id}/uploads`, { name: 'a.txt', size: bytes.length }, viewer.token)).json;
  await fetch(`${A}/api/uploads/${upload.id}?offset=0`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${viewer.token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const { blob } = (await api(A, `/api/uploads/${upload.id}/complete`, {}, viewer.token)).json;
  const propose = async (title, path) =>
    (await api(A, `/api/repos/${repo.id}/proposals`, { title, changes: [{ path, blobHash: blob.hash }] }, viewer.token)).json
      .proposal;
  const first = await propose('보고서 추가', 'a.txt');
  await propose('사본 추가', 'b.txt');

  const open = async (session) => {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());
    await page.goto(A + '/api/health');
    await page.evaluate(
      ({ token, user }) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
        ),
      { token: session.token, user: session.user },
    );
    return { ctx, page, s: screen(page) };
  };
  const visible = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true });

  // ── 내 제안 ─────────────────────────────────────────────
  const { ctx, page, s } = await open(viewer);
  await page.goto(A + '/');
  await s.onRepos('기여자').waitFor();
  await page.getByRole('button', { name: '내 제안' }).waitFor();
  t.ok('저장소 목록에 내 제안 (새 소식 없음)');

  await api(A, `/api/proposals/${first.id}/close`, { reason: '이미 다른 경로에 있습니다.' }, owner.token);
  await page.reload();
  const withNews = page.getByRole('button', { name: '내 제안, 새 소식 1건' });
  await withNews.waitFor();
  t.ok('남이 닫으면 새 소식 1건');

  await withNews.click();
  await visible(page, '새 소식').waitFor();
  await visible(page, '주인 님이 닫음 · 방금 전').waitFor();
  t.ok('내 제안 화면 — 새 소식 배지와 닫은 사람');

  await visible(page, '보고서 추가').click();
  await visible(page, '이미 다른 경로에 있습니다.').waitFor();
  t.ok('닫는 이유가 의견으로 보인다');
  await page.goBack();
  await visible(page, '사본 추가').waitFor();
  await visible(page, '새 소식').waitFor({ state: 'hidden' });
  t.ok('열어 본 뒤 돌아오면 새 소식이 풀린다');

  // ── 닫는 이유를 앱에서 ───────────────────────────────────
  await visible(page, '사본 추가').click();
  await page.getByRole('button', { name: '제안 닫기' }).filter({ visible: true }).click();
  await page.getByPlaceholder('예: 다른 제안으로 이미 반영했습니다.').filter({ visible: true }).fill('제가 잘못 올렸습니다.');
  await page.getByRole('button', { name: '닫기', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: '다시 열기' }).filter({ visible: true }).waitFor();
  await visible(page, '제가 잘못 올렸습니다.').waitFor();
  t.ok('제안 닫기 → 이유를 적고 닫으면 의견으로 남는다');
  await page.goBack();
  await visible(page, '사본 추가').waitFor();
  t.must((await visible(page, '새 소식').count()) === 0, '내가 스스로 닫은 것은 새 소식이 아니다');

  // ── 다른 기기 모두 로그아웃 ───────────────────────────────
  const other = (await api(A, '/api/auth/login', { email: `ac-기여자-${env.run}@a.test`, password: 'password-1' })).json.token;
  await page.goto(A + '/');
  await s.onRepos('기여자').waitFor();
  await s.openSettings();
  await page.getByRole('button', { name: '다른 기기 모두 로그아웃' }).click();
  await page.getByText('다른 기기에서 모두 로그아웃했습니다.').waitFor();
  t.must((await api(A, '/api/auth/me', undefined, other)).status === 401, '다른 기기 토큰은 401');
  await page.goto(A + '/');
  await s.onRepos('기여자').waitFor();
  t.ok('이 기기는 새 토큰으로 그대로 쓴다');

  // ── 로그아웃이 토큰을 끊는다 ──────────────────────────────
  const token = (await s.store()).servers[0].token;
  await s.openSettings();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: '로그인' }).waitFor();
  t.must((await api(A, '/api/auth/me', undefined, token)).status === 401, '로그아웃한 토큰은 복사해 둬도 401');
  await ctx.close();

  // ── 활동 기록 (소유자) ──────────────────────────────────
  const o = await open(owner);
  await o.page.goto(`${A}/repo/${repo.id}/members`);
  await o.page.getByRole('button', { name: '활동 기록' }).click();
  await visible(o.page, '기여자 님이 초대로 참여했습니다 (열람)').waitFor();
  await visible(o.page, '주인 님이 초대를 만들었습니다 (열람)').waitFor();
  await visible(o.page, '주인 님이 저장소를 만들었습니다').waitFor();
  t.ok('소유자는 멤버 화면에서 활동 기록을 본다');
  await o.ctx.close();
}
