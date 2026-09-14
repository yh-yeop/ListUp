import { api, fillServerForm, screen, signupInApp } from '../lib.mjs';

export const title = '로그인 정보 저장 — 클라이언트의 비밀번호 관리자';

/**
 * PC 앱이 창에 넣어 줄 저장소(window.listupDesktop.credentials)를 흉내 낸다. 새로고침해도 남도록
 * localStorage 에 둔다. 폰(expo-secure-store)은 같은 코드 경로의 네이티브 저장소라 여기서는 못 본다.
 */
function installFakeDesktopBridge() {
  const K = '__fake_vault__';
  const read = () => JSON.parse(localStorage.getItem(K) ?? '{}');
  window.listupDesktop = {
    credentials: {
      get: async (k) => read()[k] ?? null,
      set: async (k, v) => {
        const m = read();
        m[k] = v;
        localStorage.setItem(K, JSON.stringify(m));
      },
      remove: async (k) => {
        const m = read();
        delete m[k];
        localStorage.setItem(K, JSON.stringify(m));
      },
    },
  };
}

export default async function run(t, env) {
  const { A, B, C } = env;
  const ALICE = `alice-${env.run}@a.test`;

  // 안전한 저장소가 없는 웹(서버가 주는 페이지)에는 저장 스위치가 없다
  {
    const bareCtx = await env.newContext();
    const bare = await bareCtx.newPage();
    await bare.goto(A + '/');
    await bare.getByRole('button', { name: '로그인' }).waitFor();
    t.must((await bare.getByText('이 기기에 로그인 정보 저장').count()) === 0, '서버가 주는 웹: 저장 스위치 없음');
    await bareCtx.close();
  }

  const ctx = await env.newContext();
  await ctx.addInitScript(installFakeDesktopBridge);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const s = screen(page);
  const loginPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/auth/login')) loginPosts.push(r.url());
  });

  const rememberSwitch = () => page.getByRole('switch', { name: '이 기기에 로그인 정보 저장' });
  const vault = () => page.evaluate(() => JSON.parse(localStorage.getItem('__fake_vault__') ?? '{}'));
  const serverA = async () => (await s.store()).servers.find((x) => x.url === A);
  const vaultA = async () => {
    const raw = (await vault())[`listup.login.${(await serverA()).id}`];
    return raw ? JSON.parse(raw) : null;
  };
  const breakTokenA = () =>
    page.evaluate((A) => {
      const st = JSON.parse(localStorage.getItem('listup.servers'));
      st.servers.find((e) => e.url === A).token = 'expired.token';
      localStorage.setItem('listup.servers', JSON.stringify(st));
    }, A);

  // 서버 추가 → 가입 (저장 스위치 기본 켜짐) → 이메일·비밀번호 저장
  await page.goto(C + '/');
  await s.listIntro().waitFor();
  await fillServerForm(page, 'A서버', A);
  await page.getByRole('button', { name: '저장하고 들어가기' }).click();
  await page.getByText('서버: A서버').waitFor();
  t.must((await rememberSwitch().getAttribute('aria-checked')) === 'true', '로그인 화면: 저장 스위치 기본 켜짐');
  await signupInApp(page, 'alice', ALICE, 'password-a1');
  let saved = await vaultA();
  t.must(saved?.email === ALICE && saved?.password === 'password-a1', '가입 → 로그인 정보 저장됨');

  // 토큰이 만료되면 저장된 계정으로 조용히 다시 로그인
  await breakTokenA();
  loginPosts.length = 0;
  await page.reload();
  await s.onRepos('alice').waitFor();
  t.must(s.path() === '/repos', '만료된 토큰으로 열기 → 로그인 화면 없이 /repos');
  const tokenAfter = (await serverA()).token;
  t.must(tokenAfter && tokenAfter !== 'expired.token', '새 토큰으로 바뀜');
  t.must(loginPosts.length === 1, `자동 로그인 요청 1번 (${loginPosts.length})`);

  // 직접 로그아웃한 서버는 자동으로 들어가지 않는다 — 채워 둔 채 한 번 누르기
  await s.openSettings();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await s.listIntro().waitFor();
  t.must((await s.card('A서버').innerText()).includes('계정 저장됨'), '목록 카드: 계정 저장됨');
  loginPosts.length = 0;
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  t.must(s.path() === '/login' && loginPosts.length === 0, '로그아웃한 서버 선택 → 자동 로그인 안 함');
  t.must((await s.inputs().nth(0).inputValue()) === ALICE, '로그인 화면: 이메일 채워짐');
  t.must((await s.inputs().nth(1).inputValue()) === 'password-a1', '로그인 화면: 비밀번호 채워짐');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.must((await serverA()).signedOut === false, '다시 로그인 → 자동 로그인 다시 켜짐');

  // 다른 곳에서 비밀번호를 바꿨으면: 자동 로그인 1번 실패 → 저장된 비밀번호 지움 → 다시 시도 안 함
  t.must(
    (await api(A, '/api/auth/password', { currentPassword: 'password-a1', newPassword: 'password-a2' }, (await serverA()).token)).status === 200,
    '다른 곳에서 비밀번호 변경',
  );
  await breakTokenA();
  loginPosts.length = 0;
  await page.reload();
  await s.listIntro().waitFor();
  t.must(s.path() === '/servers' && loginPosts.length === 1, `틀린 비밀번호 자동 로그인 1번 → 목록 (${loginPosts.length})`);
  saved = await vaultA();
  t.must(saved?.email === ALICE && saved.password === null, '저장된 비밀번호 지움, 이메일 남김');
  loginPosts.length = 0;
  await page.reload();
  await s.listIntro().waitFor();
  t.must(loginPosts.length === 0, '다시 열어도 틀린 비밀번호로 재시도 안 함 (로그인 제한 보호)');

  // 이메일만 채워진 로그인 화면 → 새 비밀번호로 로그인 → 저장 갱신
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  t.must((await s.inputs().nth(0).inputValue()) === ALICE && (await s.inputs().nth(1).inputValue()) === '', '이메일만 채워짐');
  await s.inputs().nth(1).fill('password-a2');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.must((await vaultA())?.password === 'password-a2', '새 비밀번호로 저장 갱신');

  // 앱에서 비밀번호를 바꾸면 저장된 값도 바뀐다
  await s.openSettings();
  await page.locator('input[type="password"]:visible').nth(0).fill('password-a2');
  await page.locator('input[type="password"]:visible').nth(1).fill('password-a3');
  await page.getByRole('button', { name: '비밀번호 변경' }).click();
  await page.waitForTimeout(1500);
  t.must((await vaultA())?.password === 'password-a3', '앱에서 비밀번호 변경 → 저장값 갱신');
  await breakTokenA();
  await page.goto(C + '/');
  await s.onRepos('alice').waitFor();
  t.ok('바뀐 비밀번호로 자동 로그인');

  // 설정에서 저장된 로그인 정보 지우기
  await s.openSettings();
  await page.getByRole('button', { name: '저장된 로그인 정보 지우기' }).click();
  await page.waitForTimeout(800);
  t.must((await vaultA()) === null, '설정에서 지우기 → 저장소에서 사라짐');

  // 저장을 끄고 로그인하면 저장하지 않는다
  await page.getByRole('button', { name: '로그아웃' }).click();
  await s.listIntro().waitFor();
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  await s.inputs().nth(0).fill(ALICE);
  await s.inputs().nth(1).fill('password-a3');
  await rememberSwitch().click();
  t.must((await rememberSwitch().getAttribute('aria-checked')) === 'false', '저장 스위치 끔');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.must((await vaultA()) === null, '저장 끄고 로그인 → 저장 안 함');

  // 주소를 고치면 저장된 비밀번호는 지우고 이메일만 남긴다 (다른 서버로 비밀번호가 가지 않게)
  await s.openSettings();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await s.listIntro().waitFor();
  await s.card('A서버').click();
  await page.getByText('서버: A서버').waitFor();
  await s.inputs().nth(0).fill(ALICE);
  await s.inputs().nth(1).fill('password-a3');
  await page.getByRole('button', { name: '로그인' }).click();
  await s.onRepos('alice').waitFor();
  t.must((await vaultA())?.password === 'password-a3', '다시 저장');
  const aId = (await serverA()).id;
  await s.openServerList();
  await s.cardSettings('A서버').click();
  await page.getByRole('button', { name: '연결 확인' }).waitFor();
  await s.inputs().nth(1).fill(B);
  await page.getByRole('button', { name: '연결 확인' }).click();
  await page.getByText('연결을 확인했습니다.', { exact: true }).waitFor();
  loginPosts.length = 0;
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('서버: A서버').waitFor({ timeout: 10000 });
  t.must(s.path() === '/login', '지금 서버 주소 변경 → 그 서버 로그인 화면');
  t.must((await s.inputs().nth(0).inputValue()) === ALICE && (await s.inputs().nth(1).inputValue()) === '', '이메일만 채워짐 (비밀번호 없음)');
  const rawAfterEdit = (await vault())[`listup.login.${aId}`];
  const afterEdit = rawAfterEdit ? JSON.parse(rawAfterEdit) : null;
  t.must(afterEdit?.email === ALICE && afterEdit.password === null, '주소 변경 → 비밀번호 지움, 이메일 남김');
  t.must(!loginPosts.some((u) => u.startsWith(B)), '바뀐 주소(B)로 비밀번호를 보내지 않음');

  // 서버를 지우면 저장된 로그인 정보도 지운다
  await page.getByText('다른 서버', { exact: true }).click();
  await s.listIntro().waitFor();
  await s.cardSettings('A서버').click();
  await page.getByRole('button', { name: '목록에서 지우기' }).click();
  await s.listIntro().waitFor();
  await page.waitForTimeout(500);
  t.must((await vault())[`listup.login.${aId}`] === undefined, '서버 지우기 → 저장된 로그인 정보도 지움');
  await ctx.close();
}
