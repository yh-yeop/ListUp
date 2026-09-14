import { api, screen } from '../lib.mjs';

export const title = '비밀번호 재설정 — 서버 운영자가 준 코드로 새 비밀번호';

export default async function run(t, env) {
  const { A } = env;
  const email = `forgot-${env.run}@a.test`;
  const first = await api(A, '/api/auth/signup', { email, password: 'old-password-1', displayName: 'forgot' });

  // 운영자 명령: 없는 계정은 실패, 있는 계정은 코드
  const missing = env.issueResetCode(`nobody-${env.run}@a.test`);
  t.must(missing.status !== 0 && missing.text.includes('계정이 없습니다'), '없는 이메일이면 명령이 실패한다');
  const wrongFirst = env.issueResetCode(email);
  const issued = env.issueResetCode(email);
  t.must(issued.status === 0 && issued.code, `명령이 코드를 준다 (${issued.code})`);

  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const s = screen(page);
  await page.goto(`${A}/login`);
  await page.getByRole('button', { name: '로그인' }).waitFor();
  await s.inputs().nth(0).fill(email);
  await page.getByText('비밀번호를 잊었나요?').click();
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).waitFor();
  t.must(s.path() === '/reset-password', '로그인 화면 → 재설정 화면');
  t.must((await s.inputs().nth(0).inputValue()) === email, '넣어 둔 이메일을 이어받는다');

  // 먼저 발급한(새 코드로 끝난) 코드 → 거절
  await s.inputs().nth(1).fill(wrongFirst.code.toLowerCase());
  await s.inputs().nth(2).fill('new-password-1');
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).click();
  await page.getByText('재설정 코드가 올바르지 않거나 만료됐습니다', { exact: false }).waitFor();
  t.ok('이전 코드는 거절');

  await s.inputs().nth(1).fill(issued.code);
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).click();
  await page.waitForURL('**/repos', { timeout: 10000 });
  t.ok('맞는 코드 → 바로 로그인되어 저장소 목록');

  const oldToken = await fetch(`${A}/api/auth/me`, { headers: { authorization: `Bearer ${first.json.token}` } });
  t.must(oldToken.status === 401, '다른 기기(예전 토큰)의 로그인은 끊겼다');
  t.must((await api(A, '/api/auth/login', { email, password: 'new-password-1' })).status === 200, '새 비밀번호로 로그인된다');
  t.must((await api(A, '/api/auth/login', { email, password: 'old-password-1' })).status === 401, '예전 비밀번호는 안 된다');
  const again = await api(A, '/api/auth/reset', { email, code: issued.code, newPassword: 'third-password-1' });
  t.must(again.status === 400, '같은 코드는 두 번 못 쓴다');
  await ctx.close();
}
