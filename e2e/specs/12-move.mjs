import path from 'node:path';
import { api } from '../lib.mjs';

export const title = '옮기기 — 폴더 고르기·여러 개 한 번에·끌어다 놓기·열람자의 이동 제안';

async function put(base, token, repoId, filePath, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), path.basename(filePath));
  const res = await fetch(`${base}/api/repos/${repoId}/files?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`올리지 못했습니다: ${await res.text()}`);
}

const raw = async (base, token, repoId, filePath) => {
  const res = await fetch(`${base}/api/repos/${repoId}/raw?path=${encodeURIComponent(filePath)}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.text() : null;
};

async function signedIn(env, base, reg) {
  const ctx = await env.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(base + '/api/health');
  await page.evaluate(
    ({ token, user }) =>
      localStorage.setItem(
        'listup.servers',
        JSON.stringify({ version: 1, activeId: 'default', servers: [{ id: 'default', url: '', label: null, token, user, lastUsedAt: null, signedOut: false }] }),
      ),
    { token: reg.json.token, user: reg.json.user },
  );
  return { ctx, page };
}

const toast = (page, text) => page.getByTestId('toast').filter({ hasText: text });

/** 끌어다 놓기 — 브라우저의 drag 이벤트를 직접 보낸다(마우스 흉내는 머리 없는 Chromium 에서 들쭉날쭉하다). */
async function drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

export default async function run(t, env) {
  const { A } = env;
  const owner = await api(A, '/api/auth/signup', { email: `mv-${env.run}@a.test`, password: 'password-1', displayName: '주인' });
  const token = owner.json.token;
  const repoId = (await api(A, '/api/repos', { name: '옮기기' }, token)).json.repo.id;
  for (const [file, content] of [
    ['a.txt', 'A'],
    ['b.txt', 'B'],
    ['x1.txt', 'X1'],
    ['x2.txt', 'X2'],
    ['y.txt', 'Y'],
    ['z.txt', 'Z'],
    ['docs/c.txt', 'C'],
    ['archive/keep.txt', 'K'],
  ]) {
    await put(A, token, repoId, file, content);
  }

  const { ctx, page } = await signedIn(env, A, owner);
  const repoUrl = `${A}/repo/${repoId}`;
  await page.goto(repoUrl);
  const row = (name) => page.getByRole('button', { name: `${name} 내려받기`, exact: true }).first();
  const folder = (name) => page.getByRole('button', { name: `${name} 폴더 열기`, exact: true });

  // 폴더 고르기 — 경로를 치지 않고 들어가서 "여기로"
  await page.getByRole('button', { name: 'a.txt 옮기기', exact: true }).click();
  await page.getByText("'a.txt'를 어디로 옮길까요?").waitFor();
  await page.getByRole('button', { name: 'archive 폴더로 들어가기' }).click();
  await page.getByText('→ /archive').waitFor();
  await page.getByRole('button', { name: '여기로 옮기기' }).click();
  await toast(page, '옮겼습니다 — a.txt → archive/a.txt').waitFor();
  t.must((await raw(A, token, repoId, 'archive/a.txt')) === 'A' && (await raw(A, token, repoId, 'a.txt')) === null, '폴더를 골라 옮겼다');
  t.ok('폴더 고르기: 들어가서 여기로 옮긴다');

  // 새 폴더 — 옮기면 생긴다
  await page.getByRole('button', { name: 'b.txt 옮기기', exact: true }).click();
  await page.getByLabel('새 폴더 이름').fill('new');
  await page.getByRole('button', { name: '새 폴더' }).click();
  await page.getByText('새 폴더 — 옮기면 생깁니다.').waitFor();
  await page.getByRole('button', { name: '여기로 옮기기' }).click();
  await toast(page, '옮겼습니다 — b.txt → new/b.txt').waitFor();
  t.must((await raw(A, token, repoId, 'new/b.txt')) === 'B', '새 폴더로 옮겼다');
  t.ok('폴더 고르기: 새 폴더를 만들어 그 안으로');

  // 여러 개 고르기 — 스냅샷 하나
  const historyBefore = (await api(A, `/api/repos/${repoId}/history`, undefined, token)).json.snapshots.length;
  await page.getByRole('button', { name: '여러 개 고르기' }).click();
  await page.getByRole('checkbox', { name: 'x1.txt 고르기' }).click();
  await page.getByRole('checkbox', { name: 'x2.txt 고르기' }).click();
  await page.getByText('2개 고름').waitFor();
  await page.getByRole('button', { name: '옮기기', exact: true }).click();
  await page.getByText('2개를 어디로 옮길까요?').waitFor();
  await page.getByRole('button', { name: 'docs 폴더로 들어가기' }).click();
  await page.getByRole('button', { name: '여기로 옮기기' }).click();
  await toast(page, '옮겼습니다 — 2개 → docs/').waitFor();
  const history = (await api(A, `/api/repos/${repoId}/history`, undefined, token)).json.snapshots;
  t.must(
    (await raw(A, token, repoId, 'docs/x1.txt')) === 'X1' && (await raw(A, token, repoId, 'docs/x2.txt')) === 'X2',
    '고른 둘이 docs 로',
  );
  t.must(history.length === historyBefore + 1 && history[0].message.startsWith('이동 2개 → docs/'), `스냅샷 하나 (${history[0]?.message})`);
  t.ok('여러 개 고르기: 한 번에, 변경 이력 한 줄');
  await page.getByText('여러 개 고르기').waitFor();

  // 끌어다 놓기 — 폴더 줄로, 그리고 경로(맨 위)로
  await drag(page, row('y.txt'), folder('archive'));
  await toast(page, '옮겼습니다 — y.txt → archive/y.txt').waitFor();
  t.must((await raw(A, token, repoId, 'archive/y.txt')) === 'Y', '폴더 줄에 놓아 옮겼다');
  t.ok('끌어다 놓기: 파일을 폴더로');
  await folder('archive').click();
  await row('y.txt').waitFor();
  await drag(page, row('y.txt'), page.getByRole('button', { name: '최상위 폴더' }).filter({ visible: true }));
  await toast(page, '옮겼습니다 — archive/y.txt → y.txt').waitFor();
  t.must((await raw(A, token, repoId, 'y.txt')) === 'Y', '경로의 맨 위에 놓아 옮겼다');
  t.ok('끌어다 놓기: 위의 경로(맨 위)로');
  await ctx.close();

  // 열람자 — 옮기기는 변경 제안으로, 제안 화면에 "이동" 한 줄
  const viewer = await api(A, '/api/auth/signup', { email: `mv-v-${env.run}@a.test`, password: 'password-1', displayName: '열람자' });
  const invite = (await api(A, `/api/repos/${repoId}/invites`, { role: 'viewer' }, token)).json.invite;
  await api(A, `/api/invites/${invite.code}/join`, {}, viewer.json.token);
  const v = await signedIn(env, A, viewer);
  await v.page.goto(repoUrl);
  await v.page.getByRole('button', { name: 'z.txt 옮기기', exact: true }).click();
  await v.page.getByRole('button', { name: 'archive 폴더로 들어가기' }).click();
  await v.page.getByRole('button', { name: '여기로 옮기기 제안' }).click();
  await v.page.getByText('z.txt → archive/z.txt', { exact: true }).waitFor();
  await v.page.getByText('내용 그대로 옮김 · 1 B').waitFor();
  t.must((await v.page.getByText('이동', { exact: true }).count()) === 1, '제안 화면에 이동 한 줄');
  t.must((await raw(A, token, repoId, 'z.txt')) === 'Z', '반영 전에는 그대로');
  t.ok('열람자: 옮기기가 이동 제안이 된다');
  const proposals = (await api(A, `/api/repos/${repoId}/proposals`, undefined, token)).json.proposals;
  const merged = await api(A, `/api/proposals/${proposals[0].id}/merge`, {}, token);
  t.must(merged.status === 200, `반영 (${merged.status})`);
  t.must((await raw(A, token, repoId, 'archive/z.txt')) === 'Z' && (await raw(A, token, repoId, 'z.txt')) === null, '반영하면 옮겨진다');
  t.ok('열람자: 반영하면 옮겨진다');
  await v.ctx.close();
}
