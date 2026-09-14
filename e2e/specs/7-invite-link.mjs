import { api, screen } from '../lib.mjs';

export const title = '초대 링크 — 링크 하나로 가입·로그인 뒤 참여';

export default async function run(t, env) {
  const { A, C } = env;
  const owner = await api(A, '/api/auth/signup', { email: `own-${env.run}@a.test`, password: 'password-1', displayName: 'owner' });
  const repo = (await api(A, '/api/repos', { name: '초대저장소' }, owner.json.token)).json.repo;
  const makeInvite = async () =>
    (await api(A, `/api/repos/${repo.id}/invites`, { role: 'viewer', maxUses: 5 }, owner.json.token)).json.invite;

  // 초대 화면: 링크 복사 — 서버 주소와 코드가 한 링크에. localhost 는 같은 네트워크 경고.
  {
    const invite = await makeInvite();
    const ctx = await env.newContext();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A });
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });
    await page.goto(A + '/api/health');
    await page.evaluate(
      ({ token, user }) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
        ),
      { token: owner.json.token, user: owner.json.user },
    );
    await page.goto(`${A}/repo/${repo.id}/invites`);
    const expected = `${A}/join?code=${invite.code}`;
    await page.getByText(expected).first().waitFor();
    t.ok('초대마다 링크가 보인다');
    await page.getByRole('button', { name: '링크 복사' }).first().click();
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    t.must(clip === expected, `링크 복사 → ${expected}`);
    t.must(dialogs.some((m) => m.includes('같은 공유기(네트워크) 안에서만')), 'localhost 주소면 같은 네트워크에서만 열린다고 경고');
    await ctx.close();
  }

  // 서버가 주는 웹: 로그인 안 된 사람이 링크 → 가입 → 미리보기 → 참여
  {
    const invite = await makeInvite();
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const s = screen(page);
    await page.goto(`${A}/join?code=${invite.code}`);
    await page.getByText('초대받은 저장소에 참여').waitFor();
    t.must(await page.getByText('설치한 앱에서 열기').isVisible(), '웹에는 설치한 앱에서 열기 링크');
    const appHref = await page.getByText('설치한 앱에서 열기').evaluate((el) => el.closest('a')?.getAttribute('href') ?? el.getAttribute('href'));
    t.must(appHref === `listup://join?server=${encodeURIComponent(A)}&code=${invite.code}`, '앱 링크에 서버 주소와 코드');
    await page.getByRole('button', { name: '가입하기' }).click();
    await page.getByRole('button', { name: '가입하고 시작하기' }).waitFor();
    t.must(await page.getByText('가입하면 초대 코드', { exact: false }).isVisible(), '가입 화면에 이어 갈 초대 안내');
    await s.inputs().nth(0).fill('guest');
    await s.inputs().nth(1).fill(`guest-${env.run}@a.test`);
    await s.inputs().nth(2).fill('password-1');
    await page.getByRole('button', { name: '가입하고 시작하기' }).click();
    await page.getByText('초대저장소').waitFor({ timeout: 10000 });
    t.must(s.path() === '/join', '가입하면 참여 화면으로 돌아와 미리보기');
    await page.getByRole('button', { name: /코드로 참여하기$/ }).click();
    await page.waitForURL(`**/repo/${repo.id}`);
    t.ok('참여 → 저장소로');
    const members = (await api(A, `/api/repos/${repo.id}/members`, undefined, owner.json.token)).json.members;
    t.must(members.some((m) => m.displayName === 'guest'), '멤버로 들어갔다');
    await ctx.close();
  }

  // 클라이언트 모드: 앱 링크(server+code) — 목록에 없는 서버를 더하고 들어가 가입 뒤 참여
  {
    const invite = await makeInvite();
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });
    const s = screen(page);
    await page.goto(`${C}/join?server=${encodeURIComponent(A)}&code=${invite.code}`);
    await page.getByText(/^서버: /).waitFor({ timeout: 15000 });
    t.must(dialogs.some((m) => m.includes('이 서버를 목록에 더할까요?')), '목록에 없는 서버 → 더할지 묻는다');
    t.must(s.path() === '/login', '더하고 들어가 그 서버 로그인 화면');
    const st = await s.store();
    t.must(st.servers.length === 1 && st.servers[0].url === A, '서버가 목록에 들어갔다');
    t.must(await page.getByText('로그인하면 초대 코드', { exact: false }).isVisible(), '로그인 화면에 이어 갈 초대 안내');
    await page.getByText('회원가입').click();
    await page.getByRole('button', { name: '가입하고 시작하기' }).waitFor();
    await s.inputs().nth(0).fill('client');
    await s.inputs().nth(1).fill(`client-${env.run}@a.test`);
    await s.inputs().nth(2).fill('password-1');
    await page.getByRole('button', { name: '가입하고 시작하기' }).click();
    await page.getByText('초대저장소').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /코드로 참여하기$/ }).click();
    await page.waitForURL(`**/repo/${repo.id}`);
    t.ok('클라이언트 모드: 서버 추가 → 가입 → 참여');
    await ctx.close();
  }
}
