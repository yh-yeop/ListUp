import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, screen } from '../lib.mjs';

export const title = '다듬기 — 서버 이름·제안 더 보기·다시 담기·충돌 설명·올리기 멈추기·토스트';

/** 나눠 올리기 API 로 작은 파일 하나를 올려 blob 해시를 받는다. */
async function uploadBlob(base, token, repoId, name, content) {
  const body = Buffer.from(content);
  const auth = { Authorization: `Bearer ${token}` };
  const { upload } = (await api(base, `/api/repos/${repoId}/uploads`, { name, size: body.length }, token)).json;
  await fetch(`${base}/api/uploads/${upload.id}?offset=0`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/octet-stream' },
    body,
  });
  const done = await fetch(`${base}/api/uploads/${upload.id}/complete`, { method: 'POST', headers: auth });
  return (await done.json()).blob.hash;
}

/** 서버가 주는 웹에 로그인된 상태로 연다. */
async function signedInPage(env, base, reg) {
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

export default async function run(t, env) {
  const { A, C, NAMED } = env;

  // 서버 이름 — 이름 칸을 비워 두고 연결 확인하면 서버가 알려준 이름이 들어간다. 적어 둔 이름은 그대로.
  {
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    const s = screen(page);
    await page.goto(C + '/');
    await page.getByRole('button', { name: '서버 추가' }).click();
    await page.getByRole('button', { name: '연결 확인' }).waitFor();
    await s.inputs().nth(1).fill(NAMED);
    await page.getByRole('button', { name: '연결 확인' }).click();
    await page.getByText('연결을 확인했습니다', { exact: false }).waitFor();
    t.must((await s.inputs().nth(0).inputValue()) === '우리집 음악서버', '빈 이름 칸 → 서버가 알려준 이름');

    await s.inputs().nth(0).fill('내가 붙인 이름');
    await s.inputs().nth(1).fill(NAMED + '/');
    await page.getByRole('button', { name: '연결 확인' }).click();
    await page.getByText('연결을 확인했습니다', { exact: false }).waitFor();
    t.must((await s.inputs().nth(0).inputValue()) === '내가 붙인 이름', '적어 둔 이름은 덮어쓰지 않는다');
    await ctx.close();
  }

  const reg = await api(A, '/api/auth/signup', { email: `polish-${env.run}@a.test`, password: 'password-1', displayName: 'polish' });
  const token = reg.json.token;

  // 제안 목록 — 30개씩, 더 보기로 나머지
  {
    const repo = (await api(A, '/api/repos', { name: '제안 많은 곳' }, token)).json.repo;
    for (let i = 1; i <= 32; i += 1) {
      const hash = await uploadBlob(A, token, repo.id, `p${i}.txt`, `제안 ${i}`);
      const res = await api(A, `/api/repos/${repo.id}/proposals`, { title: `제안 ${i}`, changes: [{ path: `p${i}.txt`, blobHash: hash }] }, token);
      if (res.status !== 201) throw new Error(`제안을 만들지 못했습니다: ${JSON.stringify(res.json)}`);
    }
    const { ctx, page } = await signedInPage(env, A, reg);
    await page.goto(`${A}/repo/${repo.id}/proposals`);
    const numbers = page.getByText(/^#\d+$/).filter({ visible: true });
    await page.getByText('#32', { exact: true }).waitFor();
    t.must((await numbers.count()) === 30, `첫 페이지 30개 (${await numbers.count()})`);
    t.must(!(await page.getByText('#2', { exact: true }).isVisible()), '오래된 제안은 아직 없다');
    await page.getByRole('button', { name: '더 보기' }).click();
    await page.getByText('#1', { exact: true }).waitFor();
    t.must((await numbers.count()) === 32, '더 보기 → 32개 전부');
    t.must((await page.getByRole('button', { name: '더 보기' }).count()) === 0, '끝이면 더 보기가 사라진다');
    await ctx.close();
  }

  // 제안에 같은 파일을 다시 담으면 바꿀지 묻는다 — 안 바꾸면 하나만, 바꾸면 그래도 하나
  {
    const repo = (await api(A, '/api/repos', { name: '다시 담기' }, token)).json.repo;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-restage-'));
    fs.writeFileSync(path.join(work, 'note.txt'), '첫 번째');
    const { ctx, page } = await signedInPage(env, A, reg);
    page.removeAllListeners('dialog');
    const answers = [false, true];
    const asked = [];
    page.on('dialog', async (d) => {
      asked.push(d.message());
      if (answers.shift()) await d.accept();
      else await d.dismiss();
    });
    await page.goto(`${A}/repo/${repo.id}/new-proposal`);
    const add = async () => {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 담기' }).click();
      await (await chooser).setFiles(path.join(work, 'note.txt'));
    };
    await add();
    await page.getByRole('button', { name: /^제안 올리기 \(1개 변경\)$/ }).waitFor();
    await add();
    await page.waitForTimeout(500);
    t.must(asked.length === 1 && asked[0].includes('이미 담긴 파일입니다'), '같은 경로를 다시 담으면 바꿀지 묻는다');
    t.must((await page.getByRole('button', { name: /^제안 올리기 \(1개 변경\)$/ }).count()) === 1, '안 바꾸면 그대로 하나');
    fs.writeFileSync(path.join(work, 'note.txt'), '두 번째 내용');
    await add();
    await page.waitForTimeout(1500);
    t.must(asked.length === 2, '바꿀 때도 묻는다');
    await page.getByPlaceholder('예: 3월 회의록 오타 수정').filter({ visible: true }).fill('다시 담기');
    await page.getByRole('button', { name: /^제안 올리기 \(1개 변경\)$/ }).click();
    await page.waitForURL(/\/proposal\//, { timeout: 15000 });
    const proposals = (await api(A, `/api/repos/${repo.id}/proposals`, undefined, token)).json.proposals;
    const detail = (await api(A, `/api/proposals/${proposals[0].id}`, undefined, token)).json.proposal;
    t.must(detail.changes.length === 1 && detail.changes[0].size === Buffer.byteLength('두 번째 내용'), '바꾸면 새 내용 하나로 제안된다');
    await ctx.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  // 반영할 수 없는 제안 — 이유별로 나눠 설명한다
  {
    const repo = (await api(A, '/api/repos', { name: '충돌' }, token)).json.repo;
    const commit = async (changes) => {
      const res = await api(A, `/api/repos/${repo.id}/files/commit`, { changes }, token);
      if (res.status >= 300) throw new Error(`커밋 실패: ${JSON.stringify(res.json)}`);
    };
    await commit([{ path: 'doc.txt', blobHash: await uploadBlob(A, token, repo.id, 'doc.txt', '원본') }]);
    const proposal = (
      await api(A, `/api/repos/${repo.id}/proposals`, {
        title: '두 가지 충돌',
        changes: [
          { path: 'doc.txt', blobHash: await uploadBlob(A, token, repo.id, 'doc.txt', '제안본') },
          { path: 'new/inner.txt', blobHash: await uploadBlob(A, token, repo.id, 'inner.txt', '안') },
        ],
      }, token)
    ).json.proposal;
    // 제안 뒤 저장소에서 doc.txt 가 바뀌고, 'new' 라는 파일이 생긴다.
    await commit([
      { path: 'doc.txt', blobHash: await uploadBlob(A, token, repo.id, 'doc.txt', '다른 사람이 고침') },
      { path: 'new', blobHash: await uploadBlob(A, token, repo.id, 'new', '파일') },
    ]);
    const { ctx, page } = await signedInPage(env, A, reg);
    await page.goto(`${A}/proposal/${proposal.id}`);
    await page.getByText('지금은 반영할 수 없습니다').waitFor();
    t.must(await page.getByText('이 제안을 만든 뒤 저장소에서 바뀐 파일입니다', { exact: false }).isVisible(), '바뀐 파일 설명');
    t.must(await page.getByText('같은 이름의 파일이나 폴더가 생겨', { exact: false }).isVisible(), '이름이 겹친 경로 설명');
    await ctx.close();
  }

  // 폴더 올리기 멈추기 — 아무것도 반영하지 않는다
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-polish-'));
  try {
    const repo = (await api(A, '/api/repos', { name: '멈추기' }, token)).json.repo;
    const history = async () => (await api(A, `/api/repos/${repo.id}/history`, undefined, token)).json.snapshots;
    fs.mkdirSync(path.join(work, 'bigfolder'), { recursive: true });
    fs.writeFileSync(path.join(work, 'bigfolder', 'a.bin'), Buffer.alloc(12 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(work, 'bigfolder', 'b.bin'), Buffer.alloc(12 * 1024 * 1024, 2));
    const before = (await history()).length;

    const { ctx, page } = await signedInPage(env, A, reg);
    // 조각을 느리게 보내 멈출 틈을 만든다. (폴더 이름은 ASCII — 리눅스 Chromium 의 폴더 선택은 한글 이름에서 멈춘다.)
    await ctx.route('**/api/uploads/**', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1500));
      return route.continue().catch(() => {});
    });
    await page.goto(`${A}/repo/${repo.id}`);
    await page.getByRole('button', { name: '폴더 올리기' }).waitFor();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '폴더 올리기' }).click();
    await (await chooser).setFiles(path.join(work, 'bigfolder'));
    await page.getByRole('progressbar', { name: /^올리는 중/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '멈추기' }).click();
    await page.getByRole('progressbar', { name: /^올리는 중/ }).waitFor({ state: 'detached', timeout: 15000 });
    t.ok('멈추기 → 진행률이 사라진다');
    await page.getByTestId('toast').filter({ hasText: '올리기를 멈췄습니다' }).waitFor();
    t.ok('멈췄다는 안내가 토스트로');
    t.must((await history()).length === before, '저장소에 아무것도 반영하지 않는다');
    const tree = (await api(A, `/api/repos/${repo.id}/files`, undefined, token)).json.tree;
    t.must(tree.files.length === 0 && tree.dirs.length === 0, '폴더가 반만 들어가지 않는다');

    // 토스트는 눌러서 닫는다.
    await page.getByTestId('toast').first().click();
    await page.getByTestId('toast').waitFor({ state: 'detached' });
    t.ok('토스트를 누르면 닫힌다');

    // 멈춘 뒤 다시 올리면 끝까지 간다.
    await ctx.unroute('**/api/uploads/**');
    const chooser2 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '폴더 올리기' }).click();
    await (await chooser2).setFiles(path.join(work, 'bigfolder'));
    await page.getByRole('button', { name: 'bigfolder 폴더를 zip 으로 받기' }).waitFor({ timeout: 60000 });
    await page.getByTestId('toast').filter({ hasText: '2개 올렸습니다' }).waitFor();
    t.must((await history()).length === before + 1, '다시 올리면 스냅샷 하나로 반영');
    await ctx.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
