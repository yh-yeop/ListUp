import { api, screen } from '../lib.mjs';

export const title = '업데이트 알림 — GitHub 최신 릴리즈와 앱 버전';

export default async function run(t, env) {
  const { A, C, NEWER } = env;
  const releasePage = (v) => `https://github.com/yh-yeop/ListUp/releases/tag/v${v}`;
  const LATEST_PAGE = 'https://github.com/yh-yeop/ListUp/releases/latest';

  /** 대화상자를 기록하고 answer 대로 누른다. */
  async function client(options) {
    const ctx = await env.newContext(options);
    const page = await ctx.newPage();
    const dialogs = [];
    const state = { answer: true };
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      if (state.answer) await d.accept();
      else await d.dismiss();
    });
    return { ctx, page, dialogs, state, s: screen(page) };
  }

  // 최신 릴리즈가 지금 버전과 같으면 조용하다
  {
    const c = await client({ latest: env.appVersion });
    await c.page.goto(C + '/');
    await c.s.listIntro().waitFor();
    await c.page.waitForTimeout(1500);
    t.must(c.ctx.github.calls.length === 1 && c.dialogs.length === 0, '같은 버전 → 확인 1번, 제안 없음');
    await c.ctx.close();
  }

  // 새 버전이면 한 번 제안 → 받으러 가기 → 그 릴리즈 페이지
  {
    const c = await client({ latest: '99.0.0' });
    const popup = c.ctx.waitForEvent('page', { timeout: 10000 });
    await c.page.goto(C + '/');
    await c.s.listIntro().waitFor();
    const opened = await popup;
    await opened.waitForLoadState().catch(() => {});
    t.must(
      c.dialogs.length === 1 && c.dialogs[0].includes('v99.0.0') && c.dialogs[0].includes(`v${env.appVersion}`),
      `새 버전 → 제안 1번 (v99.0.0 / 지금 v${env.appVersion})`,
    );
    t.must(opened.url() === releasePage('99.0.0'), '받으러 가기 → 그 릴리즈 페이지');

    // 다시 열어도 같은 버전은 다시 묻지 않고, 12시간 안에는 GitHub 에 다시 묻지 않는다
    await c.page.reload();
    await c.s.listIntro().waitFor();
    await c.page.waitForTimeout(1500);
    t.must(c.dialogs.length === 1, '다시 열기 → 같은 버전 다시 안 물음');
    t.must(c.ctx.github.calls.length === 1, `다시 열기 → GitHub 에 다시 안 물음 (${c.ctx.github.calls.length})`);
    await c.ctx.close();
  }

  // 나중에 → 그래도 설정 화면에서 받을 수 있다
  {
    const c = await client({ latest: '99.0.0' });
    c.state.answer = false;
    const reg = await api(A, '/api/auth/signup', { email: `upd-${env.run}@a.test`, password: 'password-1', displayName: 'upd' });
    await c.page.goto(C + '/api-none');
    await c.page.evaluate(
      ({ A, token, user }) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: 's1', servers: [{ id: 's1', url: A, label: 'A', token, user, lastUsedAt: null, signedOut: false }] }),
        ),
      { A, token: reg.json.token, user: reg.json.user },
    );
    await c.page.goto(C + '/');
    await c.s.onRepos('upd').waitFor();
    await c.page.waitForTimeout(1000);
    t.must(c.dialogs.length === 1, '제안 → 나중에');
    await c.page.getByLabel('내 정보').click();
    const button = c.page.getByRole('button', { name: '새 버전 v99.0.0 받기' });
    await button.waitFor();
    const popup = c.ctx.waitForEvent('page', { timeout: 10000 });
    await button.click();
    t.must((await popup).url() === releasePage('99.0.0'), '설정 → 새 버전 받기 → 릴리즈 페이지');
    await c.ctx.close();
  }

  // GitHub 에 닿지 못하면 조용하다
  {
    const c = await client({ latest: '99.0.0', githubStatus: 500 });
    await c.page.goto(C + '/');
    await c.s.listIntro().waitFor();
    await c.page.waitForTimeout(1500);
    t.must(c.ctx.github.calls.length === 1 && c.dialogs.length === 0 && c.ctx.github.opened.length === 0, 'GitHub 오류 → 제안 없음');
    await c.ctx.close();
  }

  // 앱이 서버보다 오래돼 들어갈 수 없으면 릴리즈 페이지를 바로 연다
  {
    const c = await client({});
    await c.page.goto(C + '/api-none');
    await c.page.evaluate(
      (NEWER) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: null, servers: [{ id: 'sn', url: NEWER, label: '새서버', token: null, user: null, lastUsedAt: null, signedOut: false }] }),
        ),
      NEWER,
    );
    await c.page.goto(C + '/servers');
    await c.s.card('새서버').waitFor();
    const popup = c.ctx.waitForEvent('page', { timeout: 10000 });
    await c.s.card('새서버').click();
    t.must((await popup).url() === LATEST_PAGE, '앱 업데이트가 필요한 서버 선택 → 최신 릴리즈 페이지');
    t.must(await c.page.getByText('이 앱이 서버 (v9.0.0)보다 오래된', { exact: false }).isVisible(), '안내 문구도 함께');

    await c.page.getByRole('button', { name: '서버 추가' }).click();
    await c.page.getByRole('button', { name: '연결 확인' }).waitFor();
    await c.s.inputs().nth(1).fill(NEWER);
    const popup2 = c.ctx.waitForEvent('page', { timeout: 10000 });
    await c.page.getByRole('button', { name: '연결 확인' }).click();
    t.must((await popup2).url() === LATEST_PAGE, '서버 추가 연결 확인 → 최신 릴리즈 페이지');
    await c.ctx.close();
  }

  // 서버가 주는 웹은 업데이트를 확인하지 않는다
  {
    const c = await client({ latest: '99.0.0' });
    await c.page.goto(A + '/');
    await c.page.getByRole('button', { name: '로그인' }).waitFor();
    await c.page.waitForTimeout(1500);
    t.must(c.ctx.github.calls.length === 0 && c.dialogs.length === 0, '서버가 주는 웹 → GitHub 에 묻지 않음');
    await c.ctx.close();
  }
}
