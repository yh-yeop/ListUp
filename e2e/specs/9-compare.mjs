import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api } from '../lib.mjs';

export const title = '내 폴더와 비교 — 이름으로 견주기·받기·올리기·변경 제안 (브라우저)';

/** multipart 로 저장소에 파일 하나. */
async function put(base, repoId, token, filePath, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), path.basename(filePath));
  const res = await fetch(`${base}/api/repos/${repoId}/files?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`올리기 실패 ${filePath}: ${res.status}`);
}

/** 서버가 주는 웹에 그 계정으로 로그인된 창. */
async function openAs(env, A, session) {
  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(A + '/api/health');
  await page.evaluate(
    ({ token, user }) =>
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
      ),
    session,
  );
  return page;
}

const count = async (page, prefix) => {
  const text = await page.getByRole('tab', { name: new RegExp(`^${prefix}`) }).textContent();
  return Number(text.match(/\d+/)[0]);
};

export default async function run(t, env) {
  const { A } = env;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-compare-'));
  try {
    const owner = (await api(A, '/api/auth/signup', { email: `cmp-${env.run}@a.test`, password: 'password-1', displayName: '주인' })).json;
    const repo = (await api(A, '/api/repos', { name: '비교' }, owner.token)).json.repo;
    for (const [p, c] of [
      ['a.txt', 'AAA'],
      ['sub/b.txt', 'BB'],
      ['repo-only.txt', 'R'],
      ['deep/x/y.txt', 'Y'],
      ['c.txt', 'C'],
    ]) {
      await put(A, repo.id, owner.token, p, c);
    }

    // 내 폴더: a.txt(같은 크기), sub/b.txt(크기 다름), local-only.txt, other/c.txt(이름만 같음)
    const local = path.join(work, '내폴더');
    fs.mkdirSync(path.join(local, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(local, 'other'), { recursive: true });
    fs.writeFileSync(path.join(local, 'a.txt'), 'AAA');
    fs.writeFileSync(path.join(local, 'sub', 'b.txt'), 'BBBBB');
    fs.writeFileSync(path.join(local, 'local-only.txt'), 'L');
    fs.writeFileSync(path.join(local, 'other', 'c.txt'), 'C');

    const page = await openAs(env, A, owner);
    await page.goto(`${A}/repo/${repo.id}`);
    await page.getByRole('button', { name: '내 폴더와 비교' }).click();
    await page.getByRole('button', { name: '폴더 고르기' }).waitFor();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '폴더 고르기' }).click();
    await (await chooser).setFiles(local);
    await page.getByRole('tab', { name: /^저장소에만/ }).waitFor();
    t.must((await page.getByText('파일 4개', { exact: false }).count()) > 0, '고른 폴더의 파일 4개를 훑었다');

    // 경로로 견주기
    t.must((await count(page, '저장소에만')) === 3, '경로로: 저장소에만 3 (repo-only, deep/x/y, c)');
    t.must((await count(page, '내 폴더에만')) === 2, '경로로: 내 폴더에만 2 (local-only, other/c)');
    t.must((await count(page, '둘 다')) === 2, '경로로: 둘 다 2 (a, sub/b)');
    t.must((await page.getByRole('tab', { name: /크기 다름 1/ }).count()) === 1, '크기가 다른 sub/b.txt 를 표시');

    // 이름만
    await page.getByRole('switch', { name: '폴더 구조 무시하고 이름만 비교' }).click();
    t.must((await count(page, '저장소에만')) === 2, '이름만: 저장소에만 2 (repo-only, y)');
    t.must((await count(page, '내 폴더에만')) === 1, '이름만: 내 폴더에만 1 (local-only)');
    t.must((await count(page, '둘 다')) === 3, '이름만: 둘 다 3 (other/c 가 c 와 짝)');
    await page.getByRole('switch', { name: '폴더 구조 무시하고 이름만 비교' }).click();

    // 받기 — 브라우저는 내려받기로
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.getByRole('checkbox', { name: '모두 고르기' }).click();
    await page.getByRole('button', { name: '고른 3개 받기' }).click();
    const until = Date.now() + 15_000;
    while (downloads.length < 3 && Date.now() < until) await page.waitForTimeout(200);
    t.must(
      downloads.sort().join() === ['c.txt', 'repo-only.txt', 'y.txt'].sort().join(),
      `브라우저: 고른 파일을 내려받기로 (${downloads.join(', ')})`,
    );

    // 올리기 — 편집자는 저장소에 바로, 폴더 구조 그대로
    await page.getByRole('tab', { name: /^내 폴더에만/ }).click();
    await page.getByRole('checkbox', { name: '모두 고르기' }).click();
    await page.getByRole('button', { name: '고른 2개 저장소에 올리기' }).click();
    const untilUp = Date.now() + 20_000;
    let files = [];
    while (Date.now() < untilUp) {
      files = (await api(A, `/api/repos/${repo.id}/files?recursive=1`, undefined, owner.token)).json.tree.files.map((f) => f.path);
      if (files.includes('other/c.txt')) break;
      await page.waitForTimeout(300);
    }
    t.must(files.includes('local-only.txt') && files.includes('other/c.txt'), '편집자: 내 폴더에만 있던 2개가 같은 경로로 저장소에');
    await page.getByRole('tab', { name: /^내 폴더에만 0/ }).waitFor({ timeout: 10_000 });
    t.ok('올린 뒤 다시 견줘 내 폴더에만 0');

    // 열람자 — 올리면 변경 제안이 된다
    const invite = (await api(A, `/api/repos/${repo.id}/invites`, { role: 'viewer', maxUses: 1 }, owner.token)).json.invite;
    const viewer = (await api(A, '/api/auth/signup', { email: `cmpv-${env.run}@a.test`, password: 'password-1', displayName: '열람' })).json;
    await api(A, `/api/invites/${invite.code}/join`, {}, viewer.token);
    fs.writeFileSync(path.join(local, 'from-viewer.txt'), 'V');
    const vpage = await openAs(env, A, viewer);
    await vpage.goto(`${A}/repo/${repo.id}/compare`);
    const vchooser = vpage.waitForEvent('filechooser');
    await vpage.getByRole('button', { name: '폴더 고르기' }).click();
    await (await vchooser).setFiles(local);
    await vpage.getByRole('tab', { name: /^내 폴더에만/ }).click();
    await vpage.getByRole('checkbox', { name: '모두 고르기' }).click();
    await vpage.getByRole('button', { name: /변경 제안으로 올리기$/ }).click();
    await vpage.waitForURL(/\/proposal\//, { timeout: 20_000 });
    const proposals = (await api(A, `/api/repos/${repo.id}/proposals`, undefined, owner.token)).json.proposals;
    t.must(proposals.length === 1 && proposals[0].title.startsWith('내 폴더에서'), '열람자: 변경 제안 하나로 올라가고 그 제안으로 간다');
    const stillMissing = (await api(A, `/api/repos/${repo.id}/files?recursive=1`, undefined, owner.token)).json.tree.files.some((f) => f.path === 'from-viewer.txt');
    t.must(!stillMissing, '열람자: 저장소는 그대로');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
