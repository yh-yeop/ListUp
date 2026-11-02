import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { api, screen } from '../lib.mjs';

export const title = '전송 — 나눠 올리기·진행률·폴더·다운로드 링크·zip';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

function unzipEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.readEntry();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
    });
  });
}

export default async function run(t, env) {
  const { A, C } = env;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-e2e-transfer-'));
  try {
    const reg = await api(A, '/api/auth/signup', { email: `tr-${env.run}@a.test`, password: 'password-1', displayName: 'tr' });
    const token = reg.json.token;
    const repo = (await api(A, '/api/repos', { name: '전송' }, token)).json.repo;
    const history = async () => (await api(A, `/api/repos/${repo.id}/history`, undefined, token)).json.snapshots;
    const rawHash = async (p) => {
      const res = await fetch(`${A}/api/repos/${repo.id}/raw?path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${token}` } });
      return sha(Buffer.from(await res.arrayBuffer()));
    };

    // 서버가 주는 웹에 로그인된 상태로 연다.
    const ctx = await env.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const s = screen(page);
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

    // 큰 파일(조각 3개)과 작은 파일을 함께 — 진행률이 보이고, 커밋은 하나
    const big = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    fs.writeFileSync(path.join(work, 'big.bin'), big);
    fs.writeFileSync(path.join(work, 'small.txt'), '작은 파일');
    const before = (await history()).length;
    const chunkPuts = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/api/uploads/')) chunkPuts.push(r.url());
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 올리기' }).click();
    await (await chooser).setFiles([path.join(work, 'big.bin'), path.join(work, 'small.txt')]);
    await page.getByRole('progressbar', { name: /^올리는 중/ }).waitFor({ timeout: 10000 });
    t.ok('올리는 동안 진행률이 보인다');
    // 목록에 반영돼야 파일 행(받기 버튼)이 생긴다 — 진행률 카드의 파일 이름과 헷갈리지 않게.
    await page.getByRole('button', { name: 'big.bin 내려받기' }).first().waitFor({ timeout: 60000 });
    await page.getByRole('progressbar', { name: /^올리는 중/ }).waitFor({ state: 'detached', timeout: 60000 });
    t.must(chunkPuts.length >= 3, `큰 파일은 조각으로 (${chunkPuts.length}번)`);
    const afterUpload = await history();
    t.must(afterUpload.length === before + 1, '두 파일이 스냅샷 하나로');
    t.must((await rawHash('big.bin')) === sha(big), '큰 파일 내용이 그대로');

    // 연결이 한 번 끊겨도 이어서 올라간다 — 첫 조각 뒤 두 번째 조각 요청을 한 번 끊는다.
    const resumeFile = Buffer.alloc(12 * 1024 * 1024, 7);
    fs.writeFileSync(path.join(work, 'resume.bin'), resumeFile);
    let aborted = 0;
    await ctx.route('**/api/uploads/**', (route) => {
      const req = route.request();
      if (req.method() === 'PUT' && !req.url().includes('offset=0') && aborted === 0) {
        aborted += 1;
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    const chooser2 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 올리기' }).click();
    await (await chooser2).setFiles(path.join(work, 'resume.bin'));
    await page.getByRole('button', { name: 'resume.bin 내려받기' }).first().waitFor({ timeout: 60000 });
    await ctx.unroute('**/api/uploads/**');
    t.must(aborted === 1, '두 번째 조각 요청을 한 번 끊었다');
    t.must((await rawHash('resume.bin')) === sha(resumeFile), '끊긴 뒤 이어서 올라가 내용이 그대로');

    // 끊겨 그만둔 올리기를 다시 하면 처음부터가 아니라 받은 데서 이어 간다(U2-2) — 앱은 세션을 지우지 않고
    // 기억해 둔다(listup.uploadSessions). 새로고침으로 앱이 올리던 것을 잊은 상황을 만든다.
    const sessionsInApp = () => page.evaluate(() => JSON.parse(localStorage.getItem('listup.uploadSessions') ?? '{}'));
    const uploadRequests = () => {
      const seen = { posts: [], puts: [], deletes: [] };
      const watch = (r) => {
        if (r.method() === 'POST' && r.url().includes(`/api/repos/${repo.id}/uploads`)) seen.posts.push(r.url());
        if (r.method() === 'PUT' && r.url().includes('/api/uploads/')) seen.puts.push(r.url());
        if (r.method() === 'DELETE' && r.url().includes('/api/uploads/')) seen.deletes.push(r.url());
      };
      page.on('request', watch);
      return { ...seen, stop: () => page.off('request', watch) };
    };
    const pickOne = async (file) => {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '파일 올리기' }).click();
      await (await chooser).setFiles(file);
    };
    /** 첫 조각을 보내고 둘째 조각을 붙잡은 채 새로고침한다. 그때 앱이 기억하던 세션 id 들을 돌려준다. */
    const reloadMidUpload = async (file) => {
      let hold;
      const held = new Promise((resolve) => (hold = resolve));
      await ctx.route('**/api/uploads/**', (route) => {
        const req = route.request();
        if (req.method() === 'PUT' && !req.url().includes('offset=0')) return hold(route);
        return route.continue();
      });
      await pickOne(file);
      const route = await held;
      await page.waitForFunction(() => (localStorage.getItem('listup.uploadSessions') ?? '{}') !== '{}');
      const ids = Object.values(await sessionsInApp()).map((entry) => entry.uploadId);
      await page.reload();
      await route.abort().catch(() => {});
      await ctx.unroute('**/api/uploads/**');
      await page.getByRole('button', { name: '파일 올리기' }).waitFor();
      return ids;
    };
    const patterned = (seed) => {
      const buffer = Buffer.alloc(20 * 1024 * 1024);
      for (let i = 0; i < buffer.length; i += 4096) buffer.writeUInt32LE((i ^ seed) >>> 0, i);
      return buffer;
    };

    // ① 새로고침 뒤 같은 파일을 다시 고르면 — 새 세션 없이 기억해 둔 세션의 받은 데(첫 조각 뒤)부터.
    const againFile = patterned(0x5a5a5a5a);
    fs.writeFileSync(path.join(work, 'again.bin'), againFile);
    const [againId, ...extra] = await reloadMidUpload(path.join(work, 'again.bin'));
    t.must(againId && extra.length === 0, '올리기를 시작하면 세션을 기억해 둔다');
    const resumed = uploadRequests();
    await pickOne(path.join(work, 'again.bin'));
    await page.getByRole('button', { name: 'again.bin 내려받기' }).first().waitFor({ timeout: 60000 });
    resumed.stop();
    t.must(resumed.posts.length === 0, `다시 고르면 새 세션을 만들지 않는다 (POST ${resumed.posts.length}번)`);
    t.must(
      resumed.puts.length > 0 && resumed.puts[0].includes(againId) && !resumed.puts[0].includes('offset=0'),
      `첫 조각 요청이 받은 데서부터 (${resumed.puts[0] ?? '없음'})`,
    );
    t.must((await rawHash('again.bin')) === sha(againFile), '이어 올린 파일 내용이 그대로');
    t.must(Object.keys(await sessionsInApp()).length === 0, '다 올리면 기억에서 지운다');

    // ② 연결이 계속 끊겨 있는 동안(조각 요청을 5초 동안 모두 끊음) 세션을 지우지 않고 기다렸다가, 풀리면 끝낸다.
    const steadyFile = Buffer.alloc(12 * 1024 * 1024, 3);
    fs.writeFileSync(path.join(work, 'steady.bin'), steadyFile);
    let cutting = true;
    let cut = 0;
    await ctx.route('**/api/uploads/**', (route) => {
      const req = route.request();
      if (cutting && req.method() === 'PUT' && !req.url().includes('offset=0')) {
        cut += 1;
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    const steady = uploadRequests();
    await pickOne(path.join(work, 'steady.bin'));
    while (cut === 0) await page.waitForTimeout(50);
    await page.waitForTimeout(5000);
    t.must(cut >= 2, `끊긴 동안 다시 보내 본다 (${cut}번)`);
    t.must(steady.deletes.length === 0, '끊긴 동안 업로드 세션을 지우지 않는다 (DELETE 없음)');
    cutting = false;
    await page.getByRole('button', { name: 'steady.bin 내려받기' }).first().waitFor({ timeout: 60000 });
    await ctx.unroute('**/api/uploads/**');
    steady.stop();
    t.must(steady.deletes.length === 0 && steady.posts.length === 1, '연결이 돌아오면 같은 세션으로 끝낸다');
    t.must((await rawHash('steady.bin')) === sha(steadyFile), '오래 끊긴 뒤 올린 내용이 그대로');

    // ③ 기억해 둔 세션이 첫 조각부터 막히면(서버 오류) 그 세션은 치우고 새 세션으로 처음부터 한 번 더.
    const staleFile = patterned(0x0f0f0f0f);
    fs.writeFileSync(path.join(work, 'stale.bin'), staleFile);
    const [staleId] = await reloadMidUpload(path.join(work, 'stale.bin'));
    let failed = 0;
    await ctx.route('**/api/uploads/**', (route) => {
      const req = route.request();
      if (req.method() === 'PUT' && req.url().includes(staleId) && failed === 0) {
        failed += 1;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: '시험용 서버 오류' } }),
        });
      }
      return route.continue();
    });
    const restarted = uploadRequests();
    await pickOne(path.join(work, 'stale.bin'));
    await page.getByRole('button', { name: 'stale.bin 내려받기' }).first().waitFor({ timeout: 60000 });
    await ctx.unroute('**/api/uploads/**');
    restarted.stop();
    t.must(failed === 1, '기억해 둔 세션의 첫 조각을 서버 오류로 막았다');
    t.must(restarted.deletes.some((u) => u.includes(staleId)), '막힌 세션은 서버에서 치운다');
    t.must(restarted.posts.length === 1, `새 세션을 한 번 만든다 (POST ${restarted.posts.length}번)`);
    t.must((await rawHash('stale.bin')) === sha(staleFile), '새 세션으로 올린 내용이 그대로');

    // 폴더 올리기 — 구조 그대로, 커밋 하나
    fs.mkdirSync(path.join(work, '사진', '여름'), { recursive: true });
    fs.writeFileSync(path.join(work, '사진', '여름', 'a.txt'), 'A');
    fs.writeFileSync(path.join(work, '사진', 'b.txt'), 'B');
    const beforeFolder = (await history()).length;
    const chooser3 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '폴더 올리기' }).click();
    await (await chooser3).setFiles(path.join(work, '사진'));
    await page.getByRole('button', { name: '사진 폴더를 zip 으로 받기' }).waitFor({ timeout: 30000 });
    const tree = (await api(A, `/api/repos/${repo.id}/files?path=${encodeURIComponent('사진/여름')}`, undefined, token)).json.tree;
    t.must(tree.files.map((f) => f.name).join() === 'a.txt', '폴더 구조 그대로 (사진/여름/a.txt)');
    t.must((await history()).length === beforeFolder + 1, '폴더도 스냅샷 하나로');

    // 이름이 겹치는 폴더는 올리기 전에 막는다(U2-4) — 파일 '충돌' 이 있는데 폴더 '충돌/안.txt' 를 고르면
    // 다 올린 뒤 커밋에서 409 가 나는 대신, 바이트를 하나도 보내지 않고 바로 알린다.
    const form = new FormData();
    form.append('file', new Blob(['파일']), '충돌');
    const clashFile = await fetch(`${A}/api/repos/${repo.id}/files?path=${encodeURIComponent('충돌')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    t.must(clashFile.ok, `파일 '충돌' 을 만들었다 (${clashFile.status})`);
    await page.reload();
    await page.getByRole('button', { name: '충돌 내려받기' }).first().waitFor({ timeout: 10000 });
    fs.mkdirSync(path.join(work, '충돌'), { recursive: true });
    fs.writeFileSync(path.join(work, '충돌', '안.txt'), '안');
    const beforeClash = (await history()).length;
    const clash = uploadRequests();
    const chooserClash = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '폴더 올리기' }).click();
    await (await chooserClash).setFiles(path.join(work, '충돌'));
    const clashToast = page.getByRole('alert').filter({ hasText: '이름이 겹쳐' });
    await clashToast.waitFor({ timeout: 10000 });
    t.must((await clashToast.innerText()).includes('충돌/안.txt ↔ 파일 충돌'), '알림에 겹치는 경로와 상대를 적는다');
    await page.waitForTimeout(1000);
    clash.stop();
    t.must(clash.puts.length === 0 && clash.posts.length === 0, `겹치면 아무것도 보내지 않는다 (POST ${clash.posts.length}·PUT ${clash.puts.length}번)`);
    t.must((await history()).length === beforeClash, '겹치면 이력이 그대로');
    await clashToast.click();
    await clashToast.waitFor({ state: 'detached', timeout: 5000 });

    // 파일 받기 — 다운로드 링크로 브라우저가 직접
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'small.txt 내려받기' }).first().click();
    const got = await download;
    const saved = path.join(work, 'got-small.txt');
    await got.saveAs(saved);
    t.must(got.url().includes('/api/dl?t='), '받기는 다운로드 링크로');
    t.must(got.suggestedFilename() === 'small.txt' && fs.readFileSync(saved, 'utf8') === '작은 파일', '받은 파일 이름·내용이 그대로');

    // 폴더를 zip 으로
    const zipDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '사진 폴더를 zip 으로 받기' }).click();
    const zip = await zipDownload;
    const zipPath = path.join(work, 'photos.zip');
    await zip.saveAs(zipPath);
    const entries = await unzipEntries(zipPath);
    t.must(zip.suggestedFilename() === '사진.zip', 'zip 이름은 폴더 이름');
    t.must(
      Object.keys(entries).sort().join() === '사진/b.txt,사진/여름/a.txt' && entries['사진/여름/a.txt'].toString() === 'A',
      'zip 안에 폴더 구조와 내용 그대로',
    );
    await ctx.close();

    // 클라이언트 모드(다른 주소)에서도 — 조각 올리기와 링크 받기가 CORS 에 막히지 않는다
    const cctx = await env.newContext();
    const cpage = await cctx.newPage();
    cpage.on('dialog', (d) => d.accept());
    await cpage.goto(C + '/api-none');
    await cpage.evaluate(
      ({ A, token, user }) =>
        localStorage.setItem(
          'listup.servers',
          JSON.stringify({ version: 1, activeId: 'a', servers: [{ id: 'a', url: A, label: 'A', token, user, lastUsedAt: null, signedOut: false }] }),
        ),
      { A, token, user: reg.json.user },
    );
    await cpage.goto(`${C}/repo/${repo.id}`);
    await cpage.getByRole('button', { name: '파일 올리기' }).waitFor();
    fs.writeFileSync(path.join(work, 'from-client.txt'), '클라이언트에서');
    const chooser4 = cpage.waitForEvent('filechooser');
    await cpage.getByRole('button', { name: '파일 올리기' }).click();
    await (await chooser4).setFiles(path.join(work, 'from-client.txt'));
    await cpage.getByRole('button', { name: 'from-client.txt 내려받기' }).first().waitFor({ timeout: 30000 });
    t.must((await rawHash('from-client.txt')) === sha(Buffer.from('클라이언트에서')), '클라이언트 모드에서 다른 주소 서버로 올리기');
    const cdl = cpage.waitForEvent('download');
    await cpage.getByRole('button', { name: 'from-client.txt 내려받기' }).first().click();
    const cgot = await cdl;
    const csaved = path.join(work, 'c.txt');
    await cgot.saveAs(csaved);
    t.must(fs.readFileSync(csaved, 'utf8') === '클라이언트에서', '클라이언트 모드에서 링크로 받기');
    await cctx.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
