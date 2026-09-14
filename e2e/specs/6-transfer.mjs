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
