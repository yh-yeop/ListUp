import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api } from '../lib.mjs';

export const title = '1.4 — 즉시 올리기·되돌리기·충돌 정리·용량·공유 링크·받기 함·따라가기·내용으로 비교·찾기·새 소식';

const lines = (...xs) => xs.map((x) => `${x}\n`).join('');

/** 저장소에 파일 하나를 직접 반영한다. */
async function put(base, token, repoId, filePath, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), path.basename(filePath));
  const res = await fetch(`${base}/api/repos/${repoId}/files?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`올리지 못했습니다: ${await res.text()}`);
  return (await res.json()).snapshotId;
}

/** 나눠 올리기로 blob 하나. */
async function blob(base, token, repoId, name, content) {
  const body = Buffer.from(content);
  const auth = { Authorization: `Bearer ${token}` };
  const { upload } = (await api(base, `/api/repos/${repoId}/uploads`, { name, size: body.length }, token)).json;
  await fetch(`${base}/api/uploads/${upload.id}?offset=0`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body });
  return (await (await fetch(`${base}/api/uploads/${upload.id}/complete`, { method: 'POST', headers: auth })).json()).blob.hash;
}

const raw = async (base, token, repoId, filePath) => {
  const res = await fetch(`${base}/api/repos/${repoId}/raw?path=${encodeURIComponent(filePath)}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.text() : null;
};

async function signedIn(env, base, reg, { clipboard = false } = {}) {
  const ctx = await env.newContext();
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
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

export default async function run(t, env) {
  const { A, B } = env;
  const owner = await api(A, '/api/auth/signup', { email: `evo-${env.run}@a.test`, password: 'password-1', displayName: '주인' });
  const token = owner.json.token;
  const newRepo = async (name) => (await api(A, '/api/repos', { name }, token)).json.repo.id;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-evo-'));

  try {
    // ① 해시로 즉시 올리기 — 이미 있는 내용은 조각을 보내지 않는다
    {
      const repoId = await newRepo('instant');
      await put(A, token, repoId, 'x.txt', 'dupdata');
      fs.writeFileSync(path.join(work, 'copy.txt'), 'dupdata');
      fs.writeFileSync(path.join(work, 'new.txt'), 'brand new');
      const { ctx, page } = await signedIn(env, A, owner);
      const puts = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().includes('/api/uploads/')) puts.push(r.url());
      });
      await page.goto(`${A}/repo/${repoId}`);
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 올리기' }).click();
      await (await chooser).setFiles([path.join(work, 'copy.txt'), path.join(work, 'new.txt')]);
      await toast(page, '이미 있던 1개는 보내지 않았습니다').waitFor({ timeout: 20000 });
      t.must(puts.length === 1, `이미 있는 내용은 보내지 않는다 (조각 요청 ${puts.length}번)`);
      t.must((await raw(A, token, repoId, 'copy.txt')) === 'dupdata', '보내지 않은 파일도 저장소에 들어간다');
      await ctx.close();
    }

    // ⑤ 되돌리기 + ⑩ 용량 + ② 보존 안내
    {
      const repoId = await newRepo('restore');
      await put(A, token, repoId, 'a.txt', '처음');
      const point = await put(A, token, repoId, 'dup1.txt', 'same');
      await put(A, token, repoId, 'a.txt', '덮어씀');
      await put(A, token, repoId, 'dup2.txt', 'same');
      const { ctx, page } = await signedIn(env, A, owner);

      await page.goto(`${A}/repo/${repoId}/history`);
      await page.getByText('최근 30일의 시점은 모두 남기고', { exact: false }).waitFor();
      t.ok('변경 이력에 서버의 보존 설정이 보인다');

      await page.goto(`${A}/repo/${repoId}?snapshot=${point}&message=${encodeURIComponent('그때')}&at=0`);
      await page.getByRole('button', { name: '저장소 전체를 이 시점으로' }).click();
      await toast(page, '되돌렸습니다').waitFor();
      t.must((await raw(A, token, repoId, 'a.txt')) === '처음', '되돌리기: 덮어쓴 파일이 그때 내용으로');
      t.must((await raw(A, token, repoId, 'dup2.txt')) === null, '되돌리기: 그 뒤에 생긴 파일은 지워진다');

      await put(A, token, repoId, 'dup2.txt', 'same');
      await page.goto(`${A}/repo/${repoId}/storage`);
      await page.getByText('내용이 같은 파일').waitFor();
      t.must((await page.getByText('2개 ×', { exact: false }).count()) > 0, '용량: 내용이 같은 파일 묶음');
      await page.getByRole('button', { name: '이것만 남기기' }).first().click();
      await toast(page, '중복을 정리했습니다').waitFor();
      const files = (await api(A, `/api/repos/${repoId}/files`, undefined, token)).json.tree.files.map((f) => f.name);
      t.must(files.filter((n) => n.startsWith('dup')).length === 1, '용량: 하나만 남기고 정리');
      await ctx.close();
    }

    // ③ 충돌 정리 — 텍스트는 줄 단위로 자동으로 합친다
    {
      const repoId = await newRepo('conflict');
      const viewer = await api(A, '/api/auth/signup', { email: `evo-v-${env.run}@a.test`, password: 'password-1', displayName: '제안자' });
      const invite = (await api(A, `/api/repos/${repoId}/invites`, { role: 'viewer' }, token)).json.invite;
      await api(A, `/api/invites/${invite.code}/join`, {}, viewer.json.token);
      await put(A, token, repoId, 'notes.md', lines('# 회의', '참석: 가', '장소: 3층', '안건: 없음'));
      const mine = await blob(A, viewer.json.token, repoId, 'notes.md', lines('# 회의', '참석: 가', '장소: 3층', '안건: 예산'));
      const proposal = (await api(A, `/api/repos/${repoId}/proposals`, { title: '안건', changes: [{ path: 'notes.md', blobHash: mine }] }, viewer.json.token)).json.proposal;
      await put(A, token, repoId, 'notes.md', lines('# 회의', '참석: 가, 나', '장소: 3층', '안건: 없음'));

      const { ctx, page } = await signedIn(env, A, owner);
      await page.goto(`${A}/proposal/${proposal.id}`);
      await page.getByRole('radio', { name: 'notes.md: 자동으로 합치기' }).waitFor();
      t.ok('충돌: 자동으로 합칠 수 있다고 보인다');
      await page.getByRole('button', { name: '고른 대로 정리' }).click();
      await toast(page, '충돌을 정리했습니다').waitFor();
      await page.getByRole('button', { name: '저장소에 반영' }).click();
      await page.getByText('저장소에 반영되었습니다', { exact: false }).waitFor();
      t.must(
        (await raw(A, token, repoId, 'notes.md')) === lines('# 회의', '참석: 가, 나', '장소: 3층', '안건: 예산'),
        '충돌: 양쪽 고친 것을 합쳐 반영',
      );
      await ctx.close();
    }

    // ⑦ 받기 링크 — 계정 없이 받는다
    {
      const repoId = await newRepo('share');
      await put(A, token, repoId, 'docs/report.txt', '보고서');
      await put(A, token, repoId, 'secret.txt', '비밀');
      const { ctx, page } = await signedIn(env, A, owner, { clipboard: true });
      await page.goto(`${A}/repo/${repoId}/shares?path=docs`);
      await page.getByRole('button', { name: '받기 링크 만들기' }).click();
      await toast(page, '링크를 복사했습니다').waitFor();
      const link = await page.evaluate(() => navigator.clipboard.readText());
      t.must(link.startsWith(`${A}/s/`), `받기 링크 (${link})`);
      await ctx.close();

      const guest = await env.newContext();
      const gpage = await guest.newPage();
      await gpage.goto(link);
      await gpage.getByText('report.txt').waitFor();
      t.must((await gpage.getByText('secret.txt').count()) === 0, '받기 링크: 링크 밖 파일은 보이지 않는다');
      const download = gpage.waitForEvent('download');
      await gpage.getByRole('button', { name: '받기' }).first().click();
      const got = await download;
      const saved = path.join(work, 'got-report.txt');
      await got.saveAs(saved);
      t.must(fs.readFileSync(saved, 'utf8') === '보고서', '받기 링크: 로그인 없이 받는다');
      await guest.close();
    }

    // ⑦ 받기 함 — 계정 없이 보내면 변경 제안이 된다
    {
      const repoId = await newRepo('inbox');
      const share = (await api(A, `/api/repos/${repoId}/shares`, { kind: 'upload', path: 'inbox', label: '사진 받기' }, token)).json.share;
      fs.writeFileSync(path.join(work, 'photo.jpg'), 'guest photo');
      const guest = await env.newContext();
      const gpage = await guest.newPage();
      await gpage.goto(`${A}/s/${share.token}`);
      await gpage.getByText('사진 받기').first().waitFor();
      await gpage.getByPlaceholder('이름').fill('이웃');
      const chooser = gpage.waitForEvent('filechooser');
      await gpage.getByRole('button', { name: '파일 고르기' }).click();
      await (await chooser).setFiles(path.join(work, 'photo.jpg'));
      await gpage.getByRole('button', { name: '1개 보내기' }).click();
      await gpage.getByText('보냈습니다').waitFor({ timeout: 20000 });
      t.ok('받기 함: 계정 없이 보냈다');
      await guest.close();
      const proposals = (await api(A, `/api/repos/${repoId}/proposals`, undefined, token)).json.proposals;
      t.must(proposals.length === 1 && proposals[0].guestName === '이웃', '받기 함: 보낸 사람 이름으로 변경 제안이 생긴다');
    }

    // ⑨ 서버 간 따라가기 — A 의 앱에서 B 서버의 저장소를 따라간다
    {
      const bob = await api(B, '/api/auth/signup', { email: `evo-b-${env.run}@b.test`, password: 'password-1', displayName: 'B주인' });
      const bRepo = (await api(B, '/api/repos', { name: 'B의 음악' }, bob.json.token)).json.repo.id;
      await put(B, bob.json.token, bRepo, 'song.mp3', '노래');
      const key = (await api(B, `/api/repos/${bRepo}/shares`, { kind: 'mirror' }, bob.json.token)).json.share;

      const { ctx, page } = await signedIn(env, A, owner);
      await page.goto(`${A}/repos`);
      await page.getByRole('button', { name: '다른 서버 저장소 따라가기' }).click();
      await page.getByPlaceholder('https://').fill(`${B}/s/${key.token}`);
      await page.getByRole('button', { name: '따라가기', exact: true }).click();
      await page.getByText('다른 서버를 따라가는 저장소').waitFor({ timeout: 15000 });
      t.ok('따라가기: 미러 저장소가 만들어지고 안내가 보인다');
      const mirrorId = new URL(page.url()).pathname.split('/')[2];
      let fileCount = 0;
      for (let i = 0; i < 50 && fileCount === 0; i += 1) {
        fileCount = (await api(A, `/api/repos/${mirrorId}`, undefined, token)).json.repo.fileCount;
        if (fileCount === 0) await new Promise((r) => setTimeout(r, 100));
      }
      t.must(fileCount === 1 && (await raw(A, token, mirrorId, 'song.mp3')) === '노래', '따라가기: 원본의 파일을 가져온다');
      t.must((await page.getByRole('button', { name: '파일 올리기' }).count()) === 0, '따라가기: 미러 저장소에는 올리는 버튼이 없다');
      await ctx.close();
    }

    // ④ 내용으로 비교 — 옮긴 파일을 찾아 다시 올리지 않고 저장소에서 옮긴다
    {
      const repoId = await newRepo('content');
      await put(A, token, repoId, 'old/c.txt', 'moved content');
      await put(A, token, repoId, 'a.txt', 'aaaa');
      const dir = path.join(work, 'cmpfolder');
      fs.mkdirSync(path.join(dir, 'new'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'new', 'c.txt'), 'moved content');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'bbbb');
      const { ctx, page } = await signedIn(env, A, owner);
      await page.goto(`${A}/repo/${repoId}/compare`);
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '폴더 고르기' }).click();
      await (await chooser).setFiles(dir);
      await page.getByRole('tab', { name: /^저장소에만/ }).waitFor();
      await page.getByRole('switch', { name: '내용으로도 확인' }).click();
      await page.getByRole('tab', { name: /^위치만 다름 1/ }).waitFor({ timeout: 15000 });
      t.must((await page.getByRole('tab', { name: /내용 다름 1/ }).count()) === 1, '내용으로: 이름은 같고 내용이 다른 파일');
      await page.getByRole('tab', { name: /^위치만 다름/ }).click();
      await page.getByRole('checkbox', { name: '모두 고르기' }).click();
      await page.getByRole('button', { name: '고른 1개 저장소에서 옮기기' }).click();
      await toast(page, '1개를 옮겼습니다').waitFor();
      t.must(
        (await raw(A, token, repoId, 'new/c.txt')) === 'moved content' && (await raw(A, token, repoId, 'old/c.txt')) === null,
        '내용으로: 다시 올리지 않고 저장소에서 내 폴더 위치로 옮긴다',
      );
      await ctx.close();
    }

    // 파일 찾기 — 저장소 안, 내 저장소 전부. 결과를 누르면 그 폴더로.
    {
      const repoId = await newRepo('search');
      await put(A, token, repoId, 'docs/deep/report-2026.txt', 'r');
      await put(A, token, repoId, 'other.txt', 'o');
      const { ctx, page } = await signedIn(env, A, owner);
      await page.goto(`${A}/repos`);
      await page.getByLabel('파일 찾기').fill('report');
      await page.getByRole('button', { name: 'docs/deep/report-2026.txt 열기' }).click();
      await page.getByText('report-2026.txt').first().waitFor();
      t.must(new URL(page.url()).pathname === `/repo/${repoId}`, '전체 찾기 → 그 저장소의 폴더로');
      // 웹 스택은 이전 화면(저장소 목록)을 DOM 에 숨겨 두므로 보이는 찾기 칸만.
      await page.getByLabel('파일 찾기').filter({ visible: true }).fill('zzz-none');
      await page.getByText('맞는 파일이 없습니다').waitFor();
      t.ok('저장소 안 찾기: 없으면 없다고');
      await ctx.close();
    }

    // 새 소식 — 남이 한 일만 읽지 않음으로 세고, 보고 나면 0
    {
      const repoId = await newRepo('news');
      const friend = await api(A, '/api/auth/signup', { email: `evo-f-${env.run}@a.test`, password: 'password-1', displayName: '친구' });
      const invite = (await api(A, `/api/repos/${repoId}/invites`, { role: 'editor' }, token)).json.invite;
      await api(A, `/api/invites/${invite.code}/join`, {}, friend.json.token);
      const { ctx, page } = await signedIn(env, A, owner);
      // 앞 절에서 손님이 보낸 받기 함 제안 등 남의 일이 이미 쌓여 있다 — 한 번 보아 읽음으로 하고 시작한다.
      await page.goto(`${A}/activity`);
      await page.getByText('파일을 바꿨습니다').first().waitFor();
      await put(A, friend.json.token, repoId, 'hello.txt', '친구가 올림');
      await put(A, token, repoId, 'mine.txt', '내가 올림');
      await page.goto(`${A}/repos`);
      await page.getByRole('button', { name: '새 소식 1개' }).waitFor();
      t.ok('새 소식: 남이 한 일 하나만 읽지 않음');
      await page.getByRole('button', { name: '새 소식 1개' }).click();
      await page.getByText('친구 님이 파일을 바꿨습니다').waitFor();
      await page.getByText('추가: mine.txt').waitFor();
      t.ok('새 소식: 내가 한 일도 보인다(읽지 않음으로 세지는 않는다)');
      await page.goBack();
      await page.getByRole('button', { name: '새 소식', exact: true }).waitFor();
      t.ok('새 소식: 보고 나면 읽지 않음이 사라진다');
      await ctx.close();
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
