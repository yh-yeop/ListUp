import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, screen } from '../lib.mjs';

export const title = '사용 흐름 — 서버 이름·올리기 멈추기·토스트·아이디';

export default async function run(t, env) {
  const { A, C, NAMED } = env;

  // 서버 이름: 연결을 확인하면 비어 있는 이름 칸에 서버가 알려준 이름이 들어간다.
  {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const s = screen(page);
    await page.goto(C + '/');
    await page.getByRole('button', { name: '서버 추가' }).click();
    await page.getByRole('button', { name: '연결 확인' }).waitFor();
    await s.inputs().nth(1).fill(NAMED);
    await page.getByRole('button', { name: '연결 확인' }).click();
    await page.getByText('연결을 확인했습니다', { exact: false }).waitFor();
    t.must((await s.inputs().nth(0).inputValue()) === '우리집 음악서버', '이름 칸이 비어 있으면 서버 이름으로 채운다');

    // 사람이 적은 이름은 건드리지 않는다.
    await s.inputs().nth(0).fill('내가 붙인 이름');
    await s.inputs().nth(1).fill(`${NAMED}/`);
    await page.getByRole('button', { name: '연결 확인' }).click();
    await page.getByText('연결을 확인했습니다', { exact: false }).waitFor();
    t.must((await s.inputs().nth(0).inputValue()) === '내가 붙인 이름', '적어 둔 이름은 그대로');
    await ctx.close();
  }

  // 올리기 멈추기
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-polish-'));
  try {
    const reg = await api(A, '/api/auth/signup', { email: `po-${env.run}@a.test`, password: 'password-1', displayName: 'po' });
    const token = reg.json.token;
    const repo = (await api(A, '/api/repos', { name: '멈추기' }, token)).json.repo;
    const history = async () => (await api(A, `/api/repos/${repo.id}/history`, undefined, token)).json.snapshots;
    const files = async () => (await api(A, `/api/repos/${repo.id}/files`, undefined, token)).json.tree.files.map((f) => f.name);

    const ctx = await env.newContext();
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.goto(A + '/api/health');
    await page.evaluate(
      ({ token, user }) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
        ),
      { token, user: reg.json.user },
    );
    await page.goto(`${A}/repo/${repo.id}`);
    await page.getByRole('button', { name: '파일 올리기' }).waitFor();

    // 조각마다 늦춰 멈출 틈을 만든다.
    const puts = [];
    const deletes = [];
    await page.route('**/api/uploads/**', async (route) => {
      const method = route.request().method();
      if (method === 'PUT') {
        puts.push(route.request().url());
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (method === 'DELETE') deletes.push(route.request().url());
      await route.continue().catch(() => {});
    });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(work, name), `${name} 내용`);
    const pick = async () => {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 올리기' }).click();
      await (await chooser).setFiles(['a.txt', 'b.txt', 'c.txt'].map((n) => path.join(work, n)));
      await page.getByRole('progressbar', { name: /^올리는 중/ }).waitFor({ timeout: 10000 });
    };

    // ① 첫 파일을 보내는 중에 멈춘다 → 아무것도 반영하지 않는다.
    const before = (await history()).length;
    await pick();
    while (puts.length < 1) await page.waitForTimeout(50);
    await page.getByRole('button', { name: '멈추기' }).click();
    await page.getByText('멈췄습니다 — 0/3개 올림').waitFor({ timeout: 10000 });
    t.must(dialogs.some((m) => m.includes('멈출까요?')), '멈추기 → 먼저 묻는다');
    t.ok('첫 파일 도중 멈춤 → 0/3 안내 토스트');
    await page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 10000 });
    t.must((await history()).length === before, '하나도 못 올렸으면 커밋 없음');
    t.must(deletes.length >= 1, '끊은 파일의 업로드 세션을 서버에서 치운다');

    // ② 첫 파일이 끝나고 둘째를 보내는 중에 멈춘다 → 다 올린 첫 파일만 반영한다.
    puts.length = 0;
    await pick();
    while (puts.length < 2) await page.waitForTimeout(50);
    await page.getByRole('button', { name: '멈추기' }).click();
    await page.getByText('멈췄습니다 — 1/3개 올림').waitFor({ timeout: 10000 });
    await page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 10000 });
    t.must((await history()).length === before + 1, '멈춰도 다 올린 파일은 커밋 하나로 반영');
    const names = await files();
    t.must(names.includes('a.txt') && !names.includes('b.txt') && !names.includes('c.txt'), '반영된 것은 a.txt 뿐');

    // 토스트는 모달이 아니다 — 누르면 닫힌다.
    const toast = page.getByRole('status').filter({ hasText: '멈췄습니다 — 1/3개 올림' });
    await toast.click();
    await toast.waitFor({ state: 'detached', timeout: 5000 });
    t.ok('토스트를 누르면 닫힌다');
    await ctx.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // 아이디 — 이메일이 아닌 아이디로 가입하고, 대소문자가 달라도 로그인된다.
  {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());
    const s = screen(page);
    const id = `Hong-${env.run}`;
    await page.goto(A + '/');
    await page.getByText('회원가입').click();
    await page.getByText('아이디', { exact: true }).filter({ visible: true }).waitFor();
    t.must(
      (await page.getByText('이메일', { exact: true }).filter({ visible: true }).count()) === 0,
      '가입 화면에 "이메일" 칸이 없고 "아이디"',
    );
    await s.inputs().nth(0).fill('홍');
    await s.inputs().nth(1).fill(id);
    await s.inputs().nth(2).fill('password-1');
    await page.getByRole('button', { name: '가입하고 시작하기' }).click();
    await s.onRepos('홍').waitFor();
    t.ok('이메일 모양이 아닌 아이디로 가입');
    await s.openSettings();
    t.must(await page.getByText(`아이디 ${id.toLowerCase()}`).isVisible(), '내 정보에 아이디(소문자로 정리)');
    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '로그인' }).waitFor();
    await s.inputs().nth(0).fill(id.toUpperCase());
    await s.inputs().nth(1).fill('password-1');
    await page.getByRole('button', { name: '로그인' }).click();
    await s.onRepos('홍').waitFor();
    t.ok('대문자로 넣어도 같은 아이디로 로그인');
    await ctx.close();
  }
}
