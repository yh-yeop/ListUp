/**
 * PC 앱 흐름 테스트 — 실제 Electron 으로 PC 앱을 띄워 "이 PC 에서 서버 열기"를 처음부터 끝까지 조작한다.
 *
 *   npm run test:desktop                 PC 앱을 묶고(desktop/.build) 돌린다. 웹 빌드가 없으면 만든다
 *   npm run test:desktop -- --no-build   지난번 묶음을 그대로 쓴다
 *   npm run test:desktop -- --app <ListUp.exe>   설치본(electron-builder 의 win-unpacked)으로 — asar·resources 경로 확인
 *
 * 설정·로그인 정보·서버 데이터는 임시 폴더(LISTUP_DESKTOP_USER_DATA)에, 서버 포트는 빈 포트로 —
 * 쓰고 있는 서버(4000)나 PC 앱과 겹치지 않는다. 공개 주소(Tailscale·빠른 터널)는 실제로 켜지 않는다.
 * 폴더 고르기 대화상자는 main 프로세스에서 가짜로 바꿔 둔다.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { api, screen } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAILURES = path.join(ROOT, 'e2e', '.cache', 'failures');
const argv = process.argv.slice(2);
const say = (m) => console.log(m);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const appIndex = argv.indexOf('--app');
const packagedExe = appIndex === -1 ? null : path.resolve(argv[appIndex + 1]);

if (!packagedExe && !argv.includes('--no-build')) {
  say('PC 앱을 묶습니다…');
  const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'desktop.mjs'), '--no-launch'], {
    stdio: 'inherit',
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const electronDir = path.join(ROOT, 'node_modules', 'electron');
const executablePath = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-desktop-e2e-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-desktop-backup-'));
const compareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-desktop-compare-'));
const PORT = await freePort();
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ port: PORT, trayNoticeShown: true }));

const env = { ...process.env, LISTUP_DESKTOP_USER_DATA: userData, LISTUP_LOG_LEVEL: 'info' };
delete env.ELECTRON_RUN_AS_NODE;

let passed = 0;
let failed = 0;
const t = {
  must(ok, label) {
    if (ok) {
      passed += 1;
      say(`  ✓ ${label}`);
    } else {
      failed += 1;
      say(`  ✗ ${label}`);
    }
  },
};

const app = await _electron.launch(
  packagedExe ? { executablePath: packagedExe, args: [], env } : { executablePath, args: [path.join(ROOT, 'desktop')], env },
);
say(packagedExe ? `설치본: ${packagedExe}` : '개발 묶음: desktop/.build');
const page = await app.firstWindow();
page.on('dialog', (d) => void d.accept());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const s = screen(page);
const hostCard = () => page.getByText('이 PC 에서 서버 열기', { exact: true });
const blocker = net.createServer();

try {
  say('\n이 PC 에서 서버 열기');

  // 1. 첫 화면 — 서버 목록 맨 위에 이 PC 카드
  await s.listIntro().waitFor();
  await hostCard().waitFor();
  t.must(page.url().startsWith('app://listup/'), '창은 app://listup 에 뜬다');
  t.must((await page.getByText('꺼짐', { exact: true }).count()) > 0, '처음에는 꺼짐');

  // 2. 켜기 → 실행 중, 서버와 브라우저용 웹이 이 포트에서
  await page.getByRole('button', { name: '서버 켜기' }).click();
  await page.getByRole('button', { name: '들어가기' }).waitFor({ timeout: 60_000 });
  t.must((await page.getByText('실행 중', { exact: true }).count()) > 0, '켜면 실행 중');
  t.must(await health(PORT), `서버가 포트 ${PORT} 에서 응답한다`);
  const web = await fetch(`http://127.0.0.1:${PORT}/`);
  t.must(web.ok && (await web.text()).includes('<html'), '브라우저로 들어오는 사람에게 웹을 준다');

  // 3. 들어가기 → 이 PC 서버에 가입
  await page.getByRole('button', { name: '들어가기' }).click();
  await page.getByText('회원가입').waitFor();
  t.must((await page.getByRole('switch', { name: '이 기기에 로그인 정보 저장' }).count()) > 0, 'PC 앱은 로그인 정보 저장 스위치를 보인다');
  await page.getByText('회원가입').click();
  await page.getByRole('button', { name: '가입하고 시작하기' }).waitFor();
  const EMAIL = `owner-${Date.now()}@a.test`;
  await s.inputs().nth(0).fill('주인');
  await s.inputs().nth(1).fill(EMAIL);
  await s.inputs().nth(2).fill('password1234');
  await page.getByRole('button', { name: '가입하고 시작하기' }).click();
  await s.onRepos('주인').waitFor();
  const store = await s.store();
  const own = store.servers.find((x) => x.url === `http://localhost:${PORT}`);
  t.must(own?.label === '이 PC' && store.activeId === own.id, '서버 목록에 "이 PC"(localhost) 로 더해지고 그 서버에 들어간다');

  // 4. 초대 링크 — localhost 가 아니라 남이 들어올 주소(공유기 안 주소)로
  const status = await page.evaluate(() => window.listupDesktop.host.getStatus());
  const { json: repoRes } = await api(`http://127.0.0.1:${PORT}`, '/api/repos', { name: '가족 사진' }, own.token);
  await api(`http://127.0.0.1:${PORT}`, `/api/repos/${repoRes.repo.id}/invites`, { role: 'viewer', expiresInDays: 7, maxUses: 1 }, own.token);
  await page.goto(`app://listup/repo/${repoRes.repo.id}/invites`);
  await page.getByRole('button', { name: '링크 복사' }).waitFor();
  const linkText = await page.getByText('/join?code=', { exact: false }).first().textContent();
  const expectedBase = status.lanUrls[0];
  t.must(Boolean(expectedBase) && linkText.startsWith(`${expectedBase}/join?code=`), `초대 링크는 공유기 안 주소로 (${expectedBase})`);

  // 4-1. 내 폴더와 비교 — PC 앱은 고른 폴더에 바로 받고, 다시 훑고, 그 폴더의 파일을 올린다
  {
    const base = `http://127.0.0.1:${PORT}`;
    const put = async (filePath, content) => {
      const form = new FormData();
      form.append('file', new Blob([content]), path.basename(filePath));
      await fetch(`${base}/api/repos/${repoRes.repo.id}/files?path=${encodeURIComponent(filePath)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${own.token}` },
        body: form,
      });
    };
    await put('앨범/노래1.txt', '하나');
    await put('앨범/깊이/노래2.txt', '둘둘');
    fs.mkdirSync(path.join(compareDir, '앨범'), { recursive: true });
    fs.writeFileSync(path.join(compareDir, '앨범', '노래1.txt'), '하나');
    fs.writeFileSync(path.join(compareDir, '내것.txt'), '내 파일');
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, compareDir);

    await page.goto(`app://listup/repo/${repoRes.repo.id}`);
    await page.getByRole('button', { name: '내 폴더와 비교' }).click();
    await page.getByRole('button', { name: '폴더 고르기' }).click();
    await page.getByRole('tab', { name: /^저장소에만/ }).waitFor({ timeout: 15_000 });
    t.must((await page.getByText(compareDir, { exact: true }).count()) > 0, '비교: 고른 폴더의 전체 경로를 보인다');
    t.must((await page.getByRole('tab', { name: /^저장소에만 1/ }).count()) === 1, '비교: 저장소에만 1 (앨범/깊이/노래2)');
    t.must((await page.getByRole('tab', { name: /^내 폴더에만 1/ }).count()) === 1, '비교: 내 폴더에만 1 (내것.txt)');

    await page.getByRole('checkbox', { name: '모두 고르기' }).click();
    await page.getByRole('button', { name: '고른 1개 내 폴더로 받기' }).click();
    await page.getByRole('tab', { name: /^저장소에만 0/ }).waitFor({ timeout: 15_000 });
    const received = path.join(compareDir, '앨범', '깊이', '노래2.txt');
    t.must(fs.existsSync(received) && fs.readFileSync(received, 'utf8') === '둘둘', '비교: 고른 폴더 안에 폴더 구조대로 받고, 다시 훑어 저장소에만 0');
    t.must(!fs.readdirSync(path.join(compareDir, '앨범', '깊이')).some((f) => f.endsWith('.listup-part')), '비교: 받는 중 임시 파일이 남지 않는다');

    await page.getByRole('tab', { name: /^내 폴더에만/ }).click();
    await page.getByRole('checkbox', { name: '모두 고르기' }).click();
    await page.getByRole('button', { name: '고른 1개 저장소에 올리기' }).click();
    await page.getByRole('tab', { name: /^내 폴더에만 0/ }).waitFor({ timeout: 20_000 });
    const raw = await fetch(`${base}/api/repos/${repoRes.repo.id}/raw?path=${encodeURIComponent('내것.txt')}`, {
      headers: { Authorization: `Bearer ${own.token}` },
    });
    t.must(raw.ok && (await raw.text()) === '내 파일', '비교: PC 앱 폴더의 파일을 main 이 읽어 저장소에 올린다');

    const outside = await page.evaluate(
      (root) => window.listupDesktop.folders.read(root, '../../escape.txt', 0, 10).then(() => 'read', (e) => String(e)),
      compareDir,
    );
    t.must(outside.includes('폴더 밖'), '비교: 고른 폴더 밖 경로는 읽지 못한다');
    const unpicked = await page.evaluate(() => window.listupDesktop.folders.scan('C:\Windows').then(() => 'scanned', (e) => String(e)));
    t.must(unpicked.includes('고르지 않은 폴더'), '비교: 대화상자로 고르지 않은 폴더는 훑지 못한다');
  }

  // 5. 관리 화면 — 설정에서 들어간다
  await page.goto('app://listup/repos');
  await s.openSettings();
  await page.getByRole('button', { name: '이 PC 서버 관리' }).click();
  await page.getByText('들어오는 주소').waitFor();
  t.must((await page.getByText(`http://localhost:${PORT}`, { exact: true }).count()) > 0, '관리 화면에 이 PC 주소');
  t.must((await page.getByRole('radio', { name: '공개하지 않음' }).getAttribute('aria-checked')) === 'true', '공개 방식은 처음에 "공개하지 않음"');

  // 6. 재설정 코드 발급
  const resetInput = page.getByPlaceholder('그사람@example.com');
  await resetInput.fill('nobody@a.test');
  await page.getByRole('button', { name: '재설정 코드 발급' }).click();
  await page.getByText('계정이 없습니다', { exact: false }).waitFor();
  t.must(true, '없는 계정이면 없다고 알린다');
  await resetInput.fill(EMAIL);
  await page.getByRole('button', { name: '재설정 코드 발급' }).click();
  const codeText = await page.getByText(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/).first().textContent({ timeout: 10_000 });
  const reset = await api(`http://127.0.0.1:${PORT}`, '/api/auth/reset', { email: EMAIL, code: codeText, newPassword: 'newpassword99' });
  t.must(reset.status === 200, '발급한 코드로 실제로 비밀번호를 바꿀 수 있다');

  // 7. 실행 중에는 포트를 못 바꾼다
  t.must(await page.getByRole('button', { name: '저장' }).isDisabled(), '실행 중에는 포트 저장이 막힌다');

  // 8. 로그가 보인다
  await page.getByText('최근 로그').waitFor({ timeout: 10_000 });
  t.must((await page.getByText('/api/health', { exact: false }).count()) > 0, '최근 로그에 요청이 남는다');

  // 9. 창을 닫아도 서버는 돈다
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 1000));
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  t.must(visible.length === 1 && visible[0] === false, '서버가 돌면 창을 닫아도 숨기기만 한다');
  t.must(await health(PORT), '창을 닫아도 서버는 응답한다');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  // 10. 끄기
  await page.getByRole('button', { name: '서버 끄기' }).click();
  await page.getByRole('button', { name: '서버 켜기' }).waitFor({ timeout: 20_000 });
  t.must(!(await health(PORT)), '끄면 서버가 응답하지 않는다');

  // 11. 백업 (꺼진 채로) — 폴더 대화상자는 가짜로
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, backupDir);
  await page.getByRole('button', { name: '백업' }).click();
  const until = Date.now() + 15_000;
  while (Date.now() < until && !fs.readdirSync(backupDir).some((f) => f.endsWith('.db'))) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const backedUp = fs.readdirSync(backupDir);
  t.must(backedUp.some((f) => /^listup-\d{8}-\d{6}\.db$/.test(f)), '백업: DB 사본을 담는다');

  // 12. 포트를 다른 프로그램이 쓰고 있으면 이유를 알린다
  await new Promise((r) => blocker.listen(PORT, '0.0.0.0', r));
  await page.getByRole('button', { name: '서버 켜기' }).click();
  await page.getByText('이미 다른 프로그램이 쓰고 있습니다', { exact: false }).first().waitFor({ timeout: 30_000 });
  t.must(true, '포트가 쓰이고 있으면 켜지 못한 이유를 보인다');

  // 13. 데이터가 임시 폴더에
  t.must(fs.existsSync(path.join(userData, 'server-data', 'listup.db')), '서버 데이터는 앱 데이터 폴더의 server-data 에');

  t.must(pageErrors.length === 0, `페이지 오류 없음${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
} catch (err) {
  failed += 1;
  say(`  ✗ 중단: ${err instanceof Error ? err.message : err}`);
  fs.mkdirSync(FAILURES, { recursive: true });
  await page.screenshot({ path: path.join(FAILURES, 'desktop.png') }).catch(() => {});
  say(`    화면: ${path.relative(ROOT, path.join(FAILURES, 'desktop.png'))}`);
} finally {
  blocker.close();
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  // Electron 이 막 끝나 파일을 잠시 붙들고 있을 수 있다.
  for (const dir of [userData, backupDir, compareDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      say(`  (임시 폴더를 지우지 못했습니다: ${dir})`);
    }
  }
}

say(`\n${passed}개 통과, ${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);
