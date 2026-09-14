import { screen } from '../lib.mjs';

export const title = '버전 확인 — API 버전이 다른 서버';

export default async function run(t, env) {
  const { C, A, NEWER, LEGACY, V110, OLDER, DEAD } = env;
  const ctx = await env.newContext();
  const page = await ctx.newPage();
  const s = screen(page);
  const card = (label) => s.card(label);

  async function checkInForm(url) {
    await s.inputs().nth(1).fill(url);
    await page.getByRole('button', { name: '연결 확인' }).click();
    await page.waitForTimeout(800);
    const text = await page.locator('body').innerText();
    const saveDisabled = await page
      .getByRole('button', { name: '저장하고 들어가기' })
      .evaluate((el) => el.getAttribute('aria-disabled') === 'true');
    return { text, saveDisabled };
  }

  // 서버 추가 폼의 연결 확인이 API 버전을 견준다
  await page.goto(C + '/servers');
  await page.getByRole('button', { name: '서버 추가' }).click();
  await page.getByRole('button', { name: '연결 확인' }).waitFor();

  let r = await checkInForm(NEWER);
  t.must(r.text.includes('이 앱이 서버 (v9.0.0)보다 오래된 버전이라 들어갈 수 없습니다'), '새 서버: "앱을 업데이트" 안내');
  t.must(r.saveDisabled, '새 서버: 저장 막힘');
  r = await checkInForm(OLDER);
  t.must(r.text.includes('이 서버 (v0.9.0)는 앱보다 오래된 버전이라 들어갈 수 없습니다'), '옛 서버: "서버 업데이트" 안내');
  t.must(r.saveDisabled, '옛 서버: 저장 막힘');
  // 1.0.0·1.1.0 서버는 API 버전은 같지만 나눠 올리기·다운로드 링크(apiLevel 2)가 없다.
  r = await checkInForm(LEGACY);
  t.must(r.text.includes('는 앱보다 오래된 버전이라 들어갈 수 없습니다'), '필드 없는 1.0.0 서버: 서버가 오래됨');
  t.must(r.saveDisabled, '1.0.0 서버: 저장 막힘');
  r = await checkInForm(V110);
  t.must(r.text.includes('이 서버 (v1.1.0)는 앱보다 오래된 버전이라'), 'apiLevel 없는 1.1.0 서버: 서버가 오래됨');
  r = await checkInForm(A);
  t.must(r.text.includes('연결을 확인했습니다') && !r.saveDisabled, '지금 서버: 들어갈 수 있음');

  // 목록을 열면 서버마다 상태를 확인해 배지로
  await page.evaluate(
    ({ A, NEWER, OLDER, DEAD }) => {
      const e = (id, url, label) => ({ id, url, label, token: null, user: null, lastUsedAt: null });
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({
          version: 1,
          activeId: null,
          servers: [e('s_a', A, '진짜'), e('s_new', NEWER, '새서버'), e('s_old', OLDER, '옛서버'), e('s_dead', DEAD, '꺼진서버')],
        }),
      );
    },
    { A, NEWER, OLDER, DEAD },
  );
  await page.goto(C + '/servers');
  await card('진짜').waitFor();
  await page.waitForTimeout(1500);
  t.must((await card('진짜').innerText()).includes('연결됨'), '배지: 같은 버전 → 연결됨');
  t.must((await card('새서버').innerText()).includes('앱 업데이트 필요'), '배지: 새 서버 → 앱 업데이트 필요');
  t.must((await card('옛서버').innerText()).includes('서버가 오래됨'), '배지: 옛 서버 → 서버가 오래됨');
  t.must((await card('꺼진서버').innerText()).includes('닿지 않음'), '배지: 꺼진 서버 → 닿지 않음');

  // 버전이 다른 서버는 눌러도 들어가지 않는다
  await card('새서버').click();
  await page.getByText('이 앱이 서버 (v9.0.0)보다 오래된', { exact: false }).waitFor({ timeout: 10000 });
  const st = await s.store();
  t.must(st.activeId === null && s.path() === '/servers', '새 서버 선택 → 안내만, 들어가지 않음');
  await ctx.close();
}
