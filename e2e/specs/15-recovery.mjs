import { api, screen } from '../lib.mjs';

export const title = '스스로 문제 풀기 — 복구 코드·아이디 찾기·끊긴 이유·연결 문제 해결·도움말';

const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export default async function run(t, env) {
  const { A } = env;
  const loginId = `rc-${env.run}`;
  const me = (await api(A, '/api/auth/signup', { username: loginId, password: 'password-1', displayName: '복구씨' })).json;

  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const s = screen(page);
  await page.goto(A + '/api/health');
  await page.evaluate(
    ({ token, user }) =>
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
      ),
    { token: me.token, user: me.user },
  );

  // ── 빈 저장소 목록: 할 일 버튼 ─────────────────────────────
  await page.goto(A + '/');
  await s.onRepos('복구씨').waitFor();
  await page.getByRole('button', { name: '초대 코드 넣기' }).waitFor();
  await page.getByRole('button', { name: '내 저장소 시작하기' }).click();
  await page.getByPlaceholder('예: 동아리 사진첩').waitFor();
  t.ok('저장소가 없으면 빈 화면에 「초대 코드 넣기」·「내 저장소 시작하기」 — 누르면 만들기 칸이 열린다');

  // ── 복구 코드 만들기 ───────────────────────────────────────
  await s.openSettings();
  await page.getByText('아직 만들지 않았습니다.').waitFor();
  await page.getByRole('button', { name: '복구 코드 만들기' }).click();
  await s.inputs().last().fill('wrong-password');
  await page.getByRole('button', { name: '복구 코드 만들기' }).click();
  await page.getByText('현재 비밀번호가 올바르지 않습니다.').waitFor();
  t.ok('비밀번호가 틀리면 만들지 않는다 (로그아웃되지 않음)');

  await s.inputs().last().fill('password-1');
  await page.getByRole('button', { name: '복구 코드 만들기' }).click();
  await page.getByText('새 복구 코드 10개를 만들었습니다').waitFor();
  const codes = (await page.getByText(CODE).filter({ visible: true }).allInnerTexts()).map((c) => c.trim());
  t.must(codes.length === 10 && new Set(codes).size === 10, `코드 10개가 한 번 보인다 (${codes[0]} …)`);
  await page.getByRole('button', { name: '적어 두었습니다' }).click();
  await page.getByText('10개 남음', { exact: false }).waitFor();
  t.must((await page.getByText(CODE).filter({ visible: true }).count()) === 0, '「적어 두었습니다」 뒤에는 원문이 사라지고 남은 수만');

  // ── 로그아웃 → 아이디 찾기 → 복구 코드만으로 ────────────────
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
  t.must((await page.getByText('로그인이 끊겼습니다').count()) === 0, '직접 로그아웃하면 「끊겼습니다」 안내가 없다');
  await page.getByRole('link', { name: '아이디를 잊었나요?' }).click();
  await page.getByRole('button', { name: '복구 코드로 아이디 찾기' }).click();
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).waitFor();
  t.must(s.path() === '/reset-password', '아이디 찾기 → 복구 코드 입력 화면');

  // 운영자 코드 모양인데 아이디가 비면 앱이 먼저 막는다
  await s.inputs().nth(1).fill('ABCDE-23456');
  await s.inputs().nth(2).fill('recovered-pass-1');
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).click();
  await page.getByText('아이디와 함께 넣어 주세요', { exact: false }).waitFor();
  t.ok('운영자 코드 + 빈 아이디 → 아이디를 넣으라고');

  await s.inputs().nth(1).fill(codes[0].toLowerCase());
  await page.getByRole('button', { name: '새 비밀번호로 로그인' }).click();
  await s.onRepos('복구씨').waitFor({ timeout: 10000 });
  await page.getByText('새 비밀번호로 들어왔습니다').waitFor();
  await page.getByText(loginId, { exact: true }).waitFor();
  await page.getByText('남은 복구 코드는 9개입니다', { exact: false }).waitFor();
  t.ok('아이디 없이 복구 코드만 → 로그인되고 아이디·남은 코드 9개를 알린다');
  await page.getByRole('button', { name: '안내 닫기' }).click();
  t.must((await page.getByText('새 비밀번호로 들어왔습니다').count()) === 0, '안내는 닫을 수 있다');

  t.must(
    (await api(A, '/api/auth/reset', { code: codes[0], newPassword: 'again-pass-12' })).status === 400,
    '쓴 복구 코드는 다시 못 쓴다',
  );
  t.must(
    (await api(A, '/api/auth/login', { username: loginId, password: 'recovered-pass-1' })).status === 200,
    '새 비밀번호로 로그인된다',
  );

  // ── 다른 기기에서 비밀번호를 바꾸면 → 로그인이 끊겼다고 알린다 ──
  const other = (await api(A, '/api/auth/login', { username: loginId, password: 'recovered-pass-1' })).json;
  await api(A, '/api/auth/password', { currentPassword: 'recovered-pass-1', newPassword: 'changed-elsewhere-1' }, other.token);
  await page.reload();
  await page.getByText('로그인이 끊겼습니다').waitFor({ timeout: 10000 });
  t.ok('토큰이 끊긴 채 앱을 열면 로그인 화면에 끊긴 이유');

  // 틀린 비밀번호 → 되찾는 길 안내
  await s.inputs().nth(0).fill(loginId);
  await s.inputs().nth(1).fill('not-the-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByText('아이디 또는 비밀번호가 올바르지 않습니다.').waitFor();
  await page.getByText('기억나지 않으면 아래에서 찾을 수 있습니다', { exact: false }).waitFor();
  t.ok('로그인 실패(401) → 아이디 규칙과 되찾는 길 안내');

  // ── 도움말 ────────────────────────────────────────────────
  await page.getByRole('link', { name: '처음이세요? ListUp 사용법' }).click();
  await page.getByText('처음 시작하는 순서').waitFor();
  await page.getByRole('link', { name: '서버에 들어가지지 않아요' }).click();
  await page.getByText('에 잘 닿습니다', { exact: false }).waitFor({ timeout: 10000 });
  t.ok('로그인 화면 → 사용법 → 연결 문제 해결 (지금 서버는 닿음)');

  // ── 연결 문제 해결: 닿지 않는 주소 ───────────────────────────
  await page.goto(`${A}/troubleshoot?url=${encodeURIComponent(env.DEAD)}`);
  await page.getByText('이것부터 확인하세요').waitFor({ timeout: 15000 });
  await page.getByText('닿지 않음', { exact: true }).waitFor();
  t.must((await page.getByText('서버가 켜져 있는지').count()) > 0, '닿지 않는 서버 → 확인할 것 목록 (서버 켜짐 …)');
  await page.getByRole('button', { name: '다시 확인' }).click();
  await page.getByText('마지막 확인', { exact: false }).waitFor();
  t.ok('「다시 확인」이 다시 확인한다');
  await ctx.close();
}
