import { api, screen } from '../lib.mjs';

export const title = '사람 사이에 쓰기 — 주소 일부만·한 번에 저장, 비밀번호 보기, 초대 QR';

export default async function run(t, env) {
  const { A, C } = env;

  // ── 서버 추가: http·포트 없이 적고, 연결 확인 없이 바로 저장 ──────────────
  {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());
    const s = screen(page);
    await page.goto(C + '/servers');
    await page.getByRole('button', { name: '서버 추가' }).click();
    await page.getByRole('button', { name: '연결 확인' }).waitFor();

    await s.inputs().nth(1).fill('localhost:1');
    await page.getByRole('button', { name: '저장하고 들어가기' }).click();
    await page.getByText('ListUp 서버 응답을 받지 못했습니다', { exact: false }).waitFor();
    const disabled = await page
      .getByRole('button', { name: '저장하고 들어가기' })
      .evaluate((el) => el.getAttribute('aria-disabled') === 'true');
    t.must(disabled, '닿지 않는 주소는 저장하지 않고, 고치기 전까지 저장이 막힌다');

    const bare = A.replace(/^http:\/\//, '');
    await s.inputs().nth(1).fill(bare);
    await page.getByRole('button', { name: '저장하고 들어가기' }).click();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    const st = await s.store();
    t.must(st.servers.some((e) => e.url === A), `'${bare}' 만 적어도 ${A} 로 찾아 저장`);
    t.ok('연결 확인을 따로 누르지 않아도 저장하며 확인하고 들어간다');

    // ── 비밀번호 보기 ──────────────────────────────────────
    const password = page.locator('input[type="password"]').filter({ visible: true });
    await password.fill('secret-123');
    await page.getByRole('button', { name: '비밀번호 보기' }).click();
    const revealed = page.locator('input[type="text"]').filter({ visible: true });
    t.must((await revealed.inputValue().catch(() => '')) === 'secret-123' || (await password.count()) === 0, '눈 버튼으로 적은 비밀번호가 보인다');
    await page.getByRole('button', { name: '비밀번호 숨기기' }).click();
    t.must((await page.locator('input[type="password"]').filter({ visible: true }).count()) === 1, '다시 누르면 가린다');
    await ctx.close();
  }

  // ── 초대 QR ─────────────────────────────────────────────
  {
    const owner = (await api(A, '/api/auth/signup', { email: `ob-${env.run}@a.test`, password: 'password-1', displayName: 'ob' })).json;
    const repo = (await api(A, '/api/repos', { name: 'QR 저장소' }, owner.token)).json.repo;
    const invite = (await api(A, `/api/repos/${repo.id}/invites`, { role: 'viewer' }, owner.token)).json.invite;
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
      { token: owner.token, user: owner.user },
    );
    await page.goto(`${A}/repo/${repo.id}/invites`);
    await page.getByRole('button', { name: 'QR 코드' }).first().click();
    const code = `${invite.code.slice(0, 5)}-${invite.code.slice(5)}`;
    await page.getByRole('img', { name: `${code} 초대 링크 QR 코드` }).waitFor();
    t.ok('QR 코드를 펼치면 초대 링크 QR 이 보인다');
    await page.getByRole('button', { name: 'QR 닫기' }).click();
    await page.getByRole('img', { name: `${code} 초대 링크 QR 코드` }).waitFor({ state: 'hidden' });
    t.ok('다시 누르면 접힌다');
    await ctx.close();
  }
}
