import { api, fillServerForm, screen, signupInApp } from '../lib.mjs';

export const title = '서버 목록 — 서버가 주는 웹 (서버 모드)';

export default async function run(t, env) {
  const { A, B, DEAD } = env;
  const ALICE = `alice-${env.run}@a.test`;
  const BOB = `bob-${env.run}@b.test`;

  // 첫 실행: 저장된 것이 없으면 로그인 화면으로 바로
  {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    await page.goto(A + '/');
    await page.getByRole('button', { name: '로그인' }).waitFor();
    t.must(page.url().endsWith('/login'), '첫 실행 → /login 직행');
    t.must(await page.getByText('서버: 기본 서버').isVisible(), '로그인 화면에 기본 서버 표시');
    await ctx.close();
  }

  // 예전 키에서 이전: 서버 목록 이전에 쓰던 사람이 로그아웃되면 안 된다
  const alice = await api(A, '/api/auth/signup', { email: ALICE, password: 'password-a1', displayName: 'alice' });
  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const s = screen(page);

  await page.goto(A + '/api/health');
  await page.evaluate(
    ({ token, user }) => {
      localStorage.clear();
      localStorage.setItem('listup.token', token);
      localStorage.setItem('listup.user', JSON.stringify(user));
    },
    { token: alice.json.token, user: alice.json.user },
  );
  await page.goto(A + '/');
  await s.onRepos('alice').waitFor();
  t.ok('이전: 로그인 유지 (/repos)');
  const legacyLeft = await page.evaluate(() => [localStorage.getItem('listup.token'), localStorage.getItem('listup.user')]);
  const st1 = await s.store();
  t.must(st1 && legacyLeft.every((v) => v === null), '이전: listup.servers 생성 + 예전 키 삭제');
  t.must(
    st1.servers.length === 1 && st1.servers[0].id === 'default' && st1.servers[0].token === alice.json.token,
    '이전: 토큰이 기본 서버 항목으로',
  );

  // 설정 → 서버 목록 → B 추가 → 바로 B 로그인 화면 → 가입
  await s.openServerList();
  t.must((await s.visibleCount(page.getByRole('button', { name: /서버로 들어가기$/ }))) === 1, '목록: 항목 1개');
  await fillServerForm(page, 'B서버', B + '/');
  t.ok('추가: 연결 확인');
  await page.getByRole('button', { name: '저장하고 들어가기' }).click();
  await page.getByText('서버: B서버').waitFor();
  t.must(page.url().endsWith('/login'), '추가 → 바로 B 로 들어가 B 로그인 화면');
  await signupInApp(page, 'bob', BOB, 'password-b1');
  t.ok('B 가입 → B 저장소 목록');

  // 전환 왕복: 다시 로그인하지 않는다
  await s.openServerList();
  await page.getByText(/^alice 님으로 로그인됨 · /).waitFor();
  t.must(await page.getByText(/^bob 님으로 로그인됨 · /).isVisible(), '목록: 두 서버 각각 로그인 상태 표시');
  await s.card('기본 서버').click();
  await s.onRepos('alice').waitFor();
  t.ok('B → A 전환: 로그인 없이 alice');
  await page.getByLabel('내 정보').click();
  t.must(await page.getByText(ALICE).isVisible(), 'A 설정에 alice 이메일');
  await page.getByRole('button', { name: '서버 목록 열기' }).click();
  await s.card('B서버').click();
  await s.onRepos('bob').waitFor();
  t.ok('A → B 전환: 로그인 없이 bob');

  const stB = await s.store();
  const bTok = stB.servers.find((x) => x.url === B).token;
  const aTok = stB.servers.find((x) => x.id === 'default').token;
  t.must(bTok && aTok && bTok !== aTok, '토큰이 서버별로 따로 저장');

  // 토큰은 발급한 서버에만 간다
  const seen = [];
  const onReq = (r) => {
    const h = r.headers()['authorization'];
    if (h) seen.push({ url: r.url(), tok: h.slice(7) });
  };
  page.on('request', onReq);
  await page.reload();
  await s.onRepos('bob').waitFor();
  t.ok('새로고침 → 지금 서버(B) 세션으로 바로 /repos');
  page.off('request', onReq);
  t.must(seen.length > 0 && seen.every((x) => x.url.startsWith(B) && x.tok === bTok), `B 토큰은 B 로만 (인증 요청 ${seen.length}건)`);

  // 401 격리: A 비밀번호를 다른 곳에서 바꾸면 A 만 풀린다
  t.must(
    (await api(A, '/api/auth/password', { currentPassword: 'password-a1', newPassword: 'password-a2' }, aTok)).status === 200,
    '다른 기기에서 A 비밀번호 변경',
  );
  await s.openServerList();
  await s.card('기본 서버').click();
  await page.getByText('서버: 기본 서버').waitFor({ timeout: 10000 });
  t.must(page.url().endsWith('/login'), 'A 로 전환 → 폐기된 토큰 확인 → A 로그인 화면');
  await page.getByText('다른 서버', { exact: true }).click();
  await page.getByText(/^bob 님으로 로그인됨 · /).waitFor();
  t.must((await s.visibleCount(page.getByText('로그인 안 됨', { exact: false }))) === 1, 'B 세션은 그대로, A 만 로그인 안 됨');

  // 꺼진 서버로 전환 → 오류만, 상태 그대로
  await page.evaluate((DEAD) => {
    const st = JSON.parse(localStorage.getItem('listup.servers'));
    st.servers.push({ id: 'srv_dead', url: DEAD, label: '꺼진서버', token: null, user: null, lastUsedAt: null });
    localStorage.setItem('listup.servers', JSON.stringify(st));
  }, DEAD);
  await page.goto(A + '/');
  await s.listIntro().waitFor();
  t.must(page.url().endsWith('/servers'), '앱을 열었을 때 로그인 안 됨 + 서버 여럿 → /servers');
  await s.card('꺼진서버').click();
  await page.getByText('ListUp 서버 응답을 받지 못했습니다', { exact: false }).waitFor({ timeout: 10000 });
  const stDead = await s.store();
  t.must(stDead.activeId === 'default' && page.url().endsWith('/servers'), '꺼진 서버: 오류 표시, 현재 서버 그대로');

  // 지우기 / 기본 서버 보호 / 이름 바꾸기
  await s.cardSettings('꺼진서버').click();
  await page.getByRole('button', { name: '목록에서 지우기' }).click();
  await s.listIntro().waitFor();
  await page.waitForTimeout(300);
  t.must((await s.visibleCount(s.card('꺼진서버'))) === 0, '지우기: 목록에서 사라짐');
  await s.cardSettings('기본 서버').click();
  await page.getByRole('button', { name: '저장', exact: true }).waitFor();
  t.must((await s.visibleCount(page.getByRole('button', { name: '목록에서 지우기' }))) === 0, '기본 서버는 지우기 버튼 없음');
  await s.inputs().nth(0).fill('A서버');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await s.card('A서버').waitFor();
  t.ok('이름 바꾸기: 목록에 반영');

  // B 로그아웃 → B 로그인 화면(목록 아님)
  await s.card('B서버').click();
  await s.onRepos('bob').waitFor();
  await page.getByLabel('내 정보').click();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByText('서버: B서버').waitFor();
  t.must(page.url().endsWith('/login'), '로그아웃 → 그 서버의 로그인 화면');
  t.must((await s.store()).servers.every((x) => x.token === null), '로그아웃한 B 토큰 삭제');

  // A 에 새 비밀번호로 다시 로그인
  await page.getByText('다른 서버', { exact: true }).click();
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  await s.inputs().nth(0).fill(ALICE);
  await s.inputs().nth(1).fill('password-a2');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.ok('A 재로그인');

  // 뒤로 가기가 이전 서버의 화면에 닿지 않는다
  const aTok2 = (await s.store()).servers.find((x) => x.id === 'default').token;
  t.must((await api(A, '/api/repos', { name: 'A전용' }, aTok2)).status === 201, 'A 에 저장소 A전용 생성');
  await page.reload();
  await page.getByText('A전용').waitFor();
  const seenVisible = async (text) => (await s.visibleCount(page.getByText(text))) > 0;

  await s.openServerList();
  await s.card('B서버').click();
  await page.getByText('서버: B서버').waitFor();
  await s.inputs().nth(0).fill(BOB);
  await s.inputs().nth(1).fill('password-b1');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('bob').waitFor();
  for (let i = 0; i < 3; i++) {
    await page.goBack();
    await page.waitForTimeout(700);
    t.must(!(await seenVisible('A전용')), `A→B 뒤 뒤로 가기 ${i + 1}회: A 저장소 안 보임`);
  }

  await page.goto(A + '/');
  await s.onRepos('bob').waitFor();
  await s.openServerList();
  await s.card('A서버').click();
  await page.getByText('A전용').waitFor();
  t.ok('B → A 직행: A 저장소 보임');
  for (let i = 0; i < 3; i++) {
    await page.goBack();
    await page.waitForTimeout(700);
    t.must(!(await seenVisible('bob 님으로 로그인됨')), `B→A 뒤 뒤로 가기 ${i + 1}회: B 화면 안 보임`);
  }
  await ctx.close();
}
