import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api } from '../lib.mjs';

export const title = '되돌리기·휴지통·검색·이미 올린 파일 건너뛰기';

export default async function run(t, env) {
  const { A } = env;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-restore-'));
  try {
    const owner = (await api(A, '/api/auth/signup', { email: `rs-${env.run}@a.test`, password: 'password-1', displayName: 'rs' })).json;
    const viewer = (await api(A, '/api/auth/signup', { email: `rv-${env.run}@a.test`, password: 'password-1', displayName: 'rv' })).json;
    const repo = (await api(A, '/api/repos', { name: '되돌리기' }, owner.token)).json.repo;
    const invite = (await api(A, `/api/repos/${repo.id}/invites`, { role: 'viewer' }, owner.token)).json.invite;
    await api(A, `/api/invites/${invite.code}/join`, {}, viewer.token);

    const auth = { Authorization: `Bearer ${owner.token}` };
    /** 나눠 올리기 API 로 파일 하나를 올려 커밋한다(준비 단계). */
    async function put(filePath, content) {
      const bytes = Buffer.from(content);
      const { upload } = (await api(A, `/api/repos/${repo.id}/uploads`, { name: path.basename(filePath), size: bytes.length }, owner.token)).json;
      await fetch(`${A}/api/uploads/${upload.id}?offset=0`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      const { blob } = (await api(A, `/api/uploads/${upload.id}/complete`, {}, owner.token)).json;
      await api(A, `/api/repos/${repo.id}/files/commit`, { changes: [{ path: filePath, blobHash: blob.hash }] }, owner.token);
    }
    const remove = (p) => fetch(`${A}/api/repos/${repo.id}/files?path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: auth });
    const raw = async (p) => (await fetch(`${A}/api/repos/${repo.id}/raw?path=${encodeURIComponent(p)}`, { headers: auth })).text();
    const names = async (dir) =>
      (await api(A, `/api/repos/${repo.id}/files?path=${encodeURIComponent(dir)}`, undefined, owner.token)).json.tree.files.map((f) => f.name);

    await put('노래/a.txt', '첫 내용');
    await put('노래/a.txt', '둘째 내용');
    await put('앨범/1.txt', '1');
    await put('앨범/2.txt', '2');
    await put('기타/노래 목록.txt', '목록');

    async function open(session) {
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
        { token: session.token, user: session.user },
      );
      return { ctx, page, dialogs };
    }

    const { ctx, page, dialogs } = await open(owner);
    await page.goto(`${A}/repo/${repo.id}`);
    await page.getByRole('button', { name: '파일 올리기' }).waitFor();

    // ③ 검색 — 저장소 전체에서, 파일 이름에서 찾은 것이 먼저
    const search = page.getByLabel('파일 찾기').filter({ visible: true });
    await search.fill('노래');
    await page.getByText('2개 찾음').waitFor();
    const first = await page.getByRole('button', { name: /내려받기$/ }).filter({ visible: true }).first().getAttribute('aria-label');
    t.must(first === '노래 목록.txt 내려받기', '이름에서 찾은 "노래 목록.txt" 가 폴더 이름에서만 찾은 a.txt 보다 앞');
    await search.fill('없는낱말');
    await page.getByText('찾은 파일이 없습니다').waitFor();
    t.ok('없으면 없다고');
    await search.fill('노래 a');
    await page.getByText('1개 찾음').waitFor();
    t.ok('낱말 여럿은 모두 들어간 것만');
    await page.getByRole('button', { name: 'a.txt 이(가) 있는 폴더 열기' }).click();
    await page.getByRole('button', { name: 'a.txt 버전' }).waitFor();
    t.must((await search.inputValue()) === '', '폴더 열기 → 검색을 닫고 그 폴더로');

    // ① 파일 버전 — 예전 버전으로 되돌리기
    await page.getByRole('button', { name: 'a.txt 버전' }).click();
    await page.getByRole('button', { name: '이 버전 받기' }).first().waitFor();
    const nowCount = await page.getByText('지금', { exact: true }).filter({ visible: true }).count();
    t.must(nowCount === 1, `맨 위 버전에 "지금" (${nowCount})`);
    const restoreButtons = page.getByRole('button', { name: '이 버전으로 되돌리기' });
    t.must((await restoreButtons.count()) === 1, '지금 버전에는 되돌리기가 없다');
    await restoreButtons.click();
    await page.getByText('버전으로 되돌렸습니다', { exact: false }).waitFor();
    t.must((await raw('노래/a.txt')) === '첫 내용', '되돌리면 예전 내용 — 다시 올리지 않고');
    t.must(dialogs.some((m) => m.includes('이 버전으로 되돌릴까요?')), '되돌리기 전에 묻는다');

    // ① 휴지통 — 폴더를 지우면 한 묶음, 한 번에 되돌리기
    await remove('앨범');
    await page.goto(`${A}/repo/${repo.id}/history`);
    await page.getByRole('button', { name: '휴지통' }).click();
    await page.getByRole('button', { name: '2개 모두 되돌리기' }).click();
    await page.getByText('2개를 되돌렸습니다').waitFor();
    t.must((await names('앨범')).sort().join() === '1.txt,2.txt', '지운 폴더의 파일이 원래 자리로');
    await page.getByText('휴지통이 비어 있습니다').waitFor();
    t.ok('되돌린 것은 휴지통에서 빠진다');
    await ctx.close();

    // 열람자는 되돌리기 대신 변경 제안
    await remove('기타/노래 목록.txt');
    const v = await open(viewer);
    await v.page.goto(`${A}/repo/${repo.id}/trash`);
    await v.page.getByRole('button', { name: '노래 목록.txt 되돌리기' }).click();
    await v.page.waitForURL(/\/proposal\//, { timeout: 10000 });
    t.must(v.dialogs.some((m) => m.includes('되돌리자고 제안할까요?')), '열람자 → 제안으로 되돌린다고 묻는다');
    t.must(!(await names('기타')).includes('노래 목록.txt'), '제안이라 저장소는 아직 그대로');
    await v.ctx.close();

    // ② 같은 폴더를 다시 올리면 이미 올라간 그대로인 파일은 건너뛴다
    const again = await open(owner);
    await again.page.goto(`${A}/repo/${repo.id}`);
    await again.page.getByRole('button', { name: '폴더 올리기' }).waitFor();
    const puts = [];
    again.page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/api/uploads/')) puts.push(r.url());
    });
    fs.mkdirSync(path.join(work, '사진', '여름'), { recursive: true });
    fs.writeFileSync(path.join(work, '사진', '여름', 'a.txt'), 'A');
    fs.writeFileSync(path.join(work, '사진', 'b.txt'), 'B');
    fs.writeFileSync(path.join(work, '사진', 'c.txt'), 'C');
    const uploadFolder = async () => {
      const chooser = again.page.waitForEvent('filechooser');
      await again.page.getByRole('button', { name: '폴더 올리기' }).click();
      await (await chooser).setFiles(path.join(work, '사진'));
    };
    await uploadFolder();
    await again.page.getByRole('button', { name: '사진 폴더를 zip 으로 받기' }).waitFor({ timeout: 30000 });
    t.must(puts.length === 3, '처음에는 3개 모두 보낸다');

    puts.length = 0;
    await uploadFolder();
    await again.page.getByText("'사진' 은(는) 모두 이미 올라가 있습니다.").waitFor();
    t.must(puts.length === 0, '다시 올리면 하나도 보내지 않는다');

    // 크기가 같아도 고친 파일은 올린다 (태그만 고친 mp3 같은 경우)
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(work, '사진', 'b.txt'), 'Z');
    await uploadFolder();
    await again.page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 30000 });
    await again.page.waitForTimeout(500);
    t.must(again.dialogs.some((m) => m.includes('이미 올라가 있는 2개는 건너뜁니다')), '건너뛸 수를 묻는 말에 알린다');
    t.must(puts.length === 1, '고친 1개만 보낸다');
    t.must((await raw('사진/b.txt')) === 'Z', '고친 내용이 반영된다');
    await again.ctx.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
