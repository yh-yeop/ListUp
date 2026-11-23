export const title = '실행 기록 — 첫 실행 동의 창, 거부·동의, 설정 화면에서 끄기';

const KEY = 'listup.telemetry.consent';

export default async function run(t, env) {
  const { A } = env;

  // ── 거부: 창이 닫히고, 새로 고쳐도 다시 묻지 않는다 ─────────────────
  {
    const ctx = await env.newContext({ telemetryConsent: null });
    const page = await ctx.newPage();
    await page.goto(A + '/');
    const dialog = page.getByRole('dialog', { name: '실행 기록 동의' });
    await dialog.waitFor();
    t.must(await page.getByText('실행 기록을 모아도 될까요?').isVisible(), '첫 실행: 동의 창이 뜬다');
    await page.getByRole('button', { name: '기록하지 않기' }).click();
    await dialog.waitFor({ state: 'hidden' });
    t.ok('「기록하지 않기」 → 창이 닫힌다');
    t.must((await page.evaluate((k) => localStorage.getItem(k), KEY)) === 'denied', '거부가 저장된다');
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    t.ok('거부해도 앱은 그대로 (로그인 화면)');

    await page.reload();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    await page.waitForTimeout(1000);
    t.must((await dialog.count()) === 0, '새로 고침 → 다시 묻지 않는다');
    await ctx.close();
  }

  // ── 동의: 서버 목록 → 실행 기록 화면에서 켜짐 확인, 끄기 ───────────────
  {
    const ctx = await env.newContext({ telemetryConsent: null });
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());
    await page.goto(A + '/servers');
    const dialog = page.getByRole('dialog', { name: '실행 기록 동의' });
    await dialog.waitFor();
    await page.getByRole('button', { name: '동의하고 기록하기' }).click();
    await dialog.waitFor({ state: 'hidden' });
    t.must((await page.evaluate((k) => localStorage.getItem(k), KEY)) === 'granted', '「동의하고 기록하기」 → 동의가 저장된다');

    await page.getByRole('button', { name: '실행 기록 설정 열기' }).click();
    await page.getByRole('button', { name: '기록 끄기' }).waitFor();
    t.must(await page.getByText('기록 중', { exact: true }).isVisible(), '실행 기록 화면: 기록 중으로 보인다');
    t.must(await page.getByRole('button', { name: '기록 내보내기' }).isVisible(), '내보내기 버튼이 있다');

    await page.getByRole('button', { name: '기록 끄기' }).click();
    await page.getByRole('button', { name: '기록 켜기' }).waitFor();
    t.must((await page.evaluate((k) => localStorage.getItem(k), KEY)) === 'denied', '「기록 끄기」 → 꺼짐이 저장된다');
    t.must(await page.getByText('꺼짐', { exact: true }).filter({ visible: true }).first().isVisible(), '상태가 꺼짐으로 바뀐다');
    await ctx.close();
  }
}
