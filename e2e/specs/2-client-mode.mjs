import { api, fillServerForm, screen, signupInApp } from '../lib.mjs';

export const title = '클라이언트 모드 — 서버 없이 켜지는 설치형 클라이언트';

export default async function run(t, env) {
  const { A, B, C } = env;
  const ALICE = `alice-${env.run}@a.test`;
  const BOB = `bob-${env.run}@b.test`;
  const leaksBefore = env.leaks.length;

  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const s = screen(page);

  async function addServer(label, url) {
    await fillServerForm(page, label, url);
    await page.getByRole('button', { name: '저장하고 들어가기' }).click();
    await page.getByText(`서버: ${label}`).waitFor();
  }

  // 첫 실행 — 서버가 하나도 없어도 켜지고, 첫 화면은 서버 목록
  await page.goto(C + '/');
  await page.getByText('아직 기억하는 서버가 없습니다').waitFor();
  t.must(s.path() === '/servers', '첫 실행 → 빈 서버 목록');
  t.must((await s.visibleCount(page.getByRole('button', { name: /서버로 들어가기$/ }))) === 0, '기본 서버 항목 없음');
  const s0 = await s.store();
  t.must(s0 && s0.servers.length === 0 && s0.activeId === null, '저장된 목록: 비어 있고 고른 서버 없음');

  // A 추가 → 바로 A 로그인 화면 → 가입, B 추가 → 가입
  await addServer('A서버', A);
  t.must(s.path() === '/login', 'A 추가 → A 로그인 화면');
  await signupInApp(page, 'alice', ALICE, 'password-a1');
  t.ok('A 가입 → A 저장소 목록');
  await s.openServerList();
  await addServer('B서버', B);
  await signupInApp(page, 'bob', BOB, 'password-b1');
  t.ok('B 추가·가입 → B 저장소 목록');

  // 다시 열면 로그인된 지금 서버로 바로
  await page.reload();
  await s.onRepos('bob').waitFor();
  t.must(s.path() === '/repos', '다시 열기(로그인됨) → 바로 /repos');

  // 로그아웃 → 서버 목록으로 (마인크래프트의 타이틀 화면)
  await s.openSettings();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await s.listIntro().waitFor();
  t.must(s.path() === '/servers', '로그아웃 → 서버 목록');
  t.must((await s.visibleCount(page.getByText(/^alice 님으로 로그인됨 · /))) === 1, 'A 로그인은 그대로');

  await s.card('A서버').click();
  await s.onRepos('alice').waitFor();
  t.ok('A 선택 → 로그인 없이 alice');

  // 세션 만료(다른 곳에서 비밀번호 변경) → 다음 요청에서 서버 목록으로
  const aTok = (await s.store()).servers.find((x) => x.url === A).token;
  t.must(
    (await api(A, '/api/auth/password', { currentPassword: 'password-a1', newPassword: 'password-a2' }, aTok)).status === 200,
    '다른 곳에서 A 비밀번호 변경',
  );
  await page.getByLabel('내 정보').click();
  await s.inputs().nth(0).fill('alice2');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await s.listIntro().waitFor({ timeout: 10000 });
  t.must(s.path() === '/servers', '세션 만료 → 서버 목록');
  t.must((await s.visibleCount(page.getByText('로그인 안 됨', { exact: false }))) === 2, 'A·B 모두 로그인 안 됨 (B 는 로그아웃했음)');

  // 로그인 안 된 서버를 고르면 그 서버의 로그인 화면
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  t.must(s.path() === '/login', '로그인 안 된 A 선택 → A 로그인 화면');
  await s.inputs().nth(0).fill(ALICE);
  await s.inputs().nth(1).fill('password-a2');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.ok('A 로그인');

  // 세션 없이 다시 열면 목록부터
  await s.openSettings();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await s.listIntro().waitFor();
  await page.reload();
  await s.listIntro().waitFor();
  t.must(s.path() === '/servers', '세션 없이 다시 열기 → 서버 목록');

  // 지금 서버(A) 지우기 → 고른 서버 없이 목록
  await s.cardSettings('A서버').click();
  await page.getByRole('button', { name: '목록에서 지우기' }).click();
  await s.listIntro().waitFor();
  await page.waitForTimeout(500);
  t.must((await s.visibleCount(s.card('A서버'))) === 0, '지금 서버 지우기 → 목록에서 사라짐');
  const s9 = await s.store();
  t.must(s9.activeId === null && s9.servers.length === 1, '고른 서버 없음, B 만 남음');
  await page.reload();
  await s.listIntro().waitFor();
  t.must(s.path() === '/servers' && (await s.visibleCount(s.card('B서버'))) === 1, '다시 열어도 목록 (B 하나)');

  t.must(!(await s.store()).servers.some((x) => x.id === 'default'), '기본 서버 항목이 생기지 않음');
  t.must(env.leaks.length === leaksBefore, `같은 주소(정적 서버)로 새는 /api 요청 없음 (${env.leaks.slice(leaksBefore).join(', ')})`);
  await ctx.close();
}
