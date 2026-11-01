import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { API_VERSION, type HealthResponse } from '@listup/shared';
import { createHarness, createInvite, createRepo, join, signup, uploadFile, type Harness, type Session } from '../../server/test/helpers.ts';
import { ListUpClient, normalizeBaseUrl, type ClientOptions } from '../src/client.ts';
import { checkServer, readConfig } from '../src/config.ts';
import { createMcpServer, decodeText } from '../src/tools.ts';

/** 실제 서버(임시 DB)를 포트로 띄우고, MCP 클라이언트로 도구를 하나씩 부른다. */

const READ_TOOLS = [
  'server_info',
  'list_repos',
  'get_repo',
  'list_files',
  'read_file',
  'list_history',
  'list_file_versions',
  'list_proposals',
  'get_proposal',
  'list_my_proposals',
];
const WRITE_TOOLS = ['download_file', 'propose_changes', 'add_comment'];

let h: Harness;
let baseUrl: string;
let owner: Session;
let viewer: Session;
let repoId: string;
let tmp: string;

async function connect(options: Partial<ClientOptions> = {}, health?: Partial<HealthResponse>) {
  const listup = new ListUpClient({
    baseUrl,
    credentials: { username: viewer.email, password: 'password1234' },
    ...options,
  });
  const server = createMcpServer(listup, { ...(await listup.health()), ...health }, '0.0.0-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult, index = 0): string {
  const item = result.content[index];
  assert.equal(item?.type, 'text');
  return (item as { text: string }).text;
}

/** 성공한 도구의 첫 글(JSON). 실패면 그 사유로 터뜨린다. */
async function ok<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(client, name, args);
  assert.ok(!result.isError, `${name} 실패: ${result.isError ? text(result) : ''}`);
  return JSON.parse(text(result).split('\n(')[0]) as T;
}

async function fails(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) {
  const result = await call(client, name, args);
  assert.equal(result.isError, true, `${name} 이 실패해야 하는데 성공했다`);
  assert.match(text(result), pattern);
}

before(async () => {
  h = await createHarness({ maxUploadBytes: 20 * 1024 * 1024 });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-mcp-test-'));

  owner = await signup(h.app, '주인');
  viewer = await signup(h.app, 'AI 열람자');
  repoId = await createRepo(h.app, owner, '문서함');
  assert.equal((await uploadFile(h.app, owner, repoId, '문서/회의록.md', '# 회의록\n첫 줄\n')).statusCode, 201);
  assert.equal((await uploadFile(h.app, owner, repoId, '문서/회의록.md', '# 회의록\n고친 줄\n')).statusCode, 201);
  assert.equal((await uploadFile(h.app, owner, repoId, '옛날.txt', '지울 파일')).statusCode, 201);
  assert.equal((await uploadFile(h.app, owner, repoId, 'data.bin', Buffer.from([0, 1, 2, 255, 0]))).statusCode, 201);
  const invite = await createInvite(h.app, owner, repoId, { role: 'viewer' });
  assert.equal((await join(h.app, viewer, invite.code)).statusCode, 200);
});

after(async () => {
  await h.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('설정·서버 확인', () => {
  test('env 에서 주소와 로그인 정보를 읽는다', () => {
    assert.throws(() => readConfig({}), /LISTUP_URL/);
    assert.throws(() => readConfig({ LISTUP_URL: 'example.com', LISTUP_TOKEN: 't' }), /http/);
    assert.throws(() => readConfig({ LISTUP_URL: 'http://x' }), /LISTUP_TOKEN/);
    assert.throws(() => readConfig({ LISTUP_URL: 'http://x', LISTUP_USERNAME: 'ai' }), /LISTUP_TOKEN/);
    assert.deepEqual(readConfig({ LISTUP_URL: 'http://x', LISTUP_TOKEN: 't' }), { baseUrl: 'http://x', token: 't', credentials: null });
    // npm run sync 와 같은 LISTUP_EMAIL 도 아이디로 받는다.
    assert.deepEqual(readConfig({ LISTUP_URL: 'http://x', LISTUP_EMAIL: 'ai', LISTUP_PASSWORD: 'pw' }).credentials, {
      username: 'ai',
      password: 'pw',
    });
    assert.equal(normalizeBaseUrl('https://a.example/api/'), 'https://a.example');
  });

  test('apiVersion 이 다르거나 수준이 낮은 서버는 거절한다', () => {
    assert.equal(checkServer({ apiVersion: API_VERSION, apiLevel: 5 }), null);
    assert.match(checkServer({ apiVersion: API_VERSION + 1, apiLevel: 5 }) ?? '', /API 버전/);
    assert.match(checkServer({ apiVersion: API_VERSION, apiLevel: 1 }) ?? '', /오래됐습니다/);
    // 필드가 없는 서버(1.1.0 까지)는 수준 1.
    assert.match(checkServer({}) ?? '', /오래됐습니다/);
  });

  test('잘라 읽은 끝의 한글이 깨져도 텍스트로 본다', () => {
    const bytes = Buffer.from('가나다', 'utf8');
    assert.equal(decodeText(bytes.subarray(0, 4)), '가');
    assert.equal(decodeText(Buffer.from([0x61, 0, 0x62])), null);
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null);
  });
});

describe('도구 목록', () => {
  test('읽기 도구에는 readOnlyHint, 설명·제약이 JSON Schema 로 옮겨진다', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, READ_TOOLS.includes(tool.name), tool.name);
    }
    // zod 인스턴스가 SDK 와 다르면 검증은 되는데 이것들이 빠진다(mcp/package.json 의 zod 를 루트와 맞출 것).
    const listFiles = tools.find((t) => t.name === 'list_files')!;
    const repoIdSchema = (listFiles.inputSchema.properties as Record<string, Record<string, unknown>>).repoId;
    assert.equal(repoIdSchema.minLength, 1);
    assert.match(String(repoIdSchema.description), /저장소 id/);
    const readFile = tools.find((t) => t.name === 'read_file')!;
    assert.equal((readFile.inputSchema.properties as Record<string, Record<string, unknown>>).maxBytes.type, 'integer');
  });
});

describe('열람자 계정으로', () => {
  test('서버·계정 정보와 저장소', async () => {
    const client = await connect();
    const info = await ok(client, 'server_info');
    assert.equal(info.account.displayName, 'AI 열람자');
    assert.equal(info.server.apiVersion, API_VERSION);

    const { repos } = await ok(client, 'list_repos');
    assert.deepEqual(
      repos.map((r: { name: string; role: string }) => [r.name, r.role]),
      [['문서함', 'viewer']],
    );
    const { repo } = await ok(client, 'get_repo', { repoId });
    assert.equal(repo.fileCount, 3);
    assert.match(repo.createdAt, /^\d{4}-\d\d-\d\dT/); // 시각은 ISO 로 보인다

    // 멤버가 아닌 저장소는 서버가 404 로 숨긴다 — 그 사유가 도구 오류로 온다.
    const other = await createRepo(h.app, owner, '비공개');
    await fails(client, 'get_repo', { repoId: other }, /HTTP 404/);
    // 인자 검증은 SDK 가 한다.
    await fails(client, 'get_repo', { repoId: '' }, /repoId/);
  });

  test('파일 목록·읽기', async () => {
    const client = await connect();
    const top = await ok(client, 'list_files', { repoId });
    assert.deepEqual(top.dirs.map((d: { name: string }) => d.name), ['문서']);
    const all = await ok(client, 'list_files', { repoId, recursive: true });
    assert.deepEqual(all.files.map((f: { path: string }) => f.path).sort(), ['data.bin', '문서/회의록.md', '옛날.txt']);

    const read = await call(client, 'read_file', { repoId, path: '문서/회의록.md' });
    assert.ok(!read.isError);
    assert.equal(text(read, 1), '# 회의록\n고친 줄\n');
    assert.equal(JSON.parse(text(read, 0)).truncated, false);

    // 앞부분만 — 한글 중간에서 잘려도 깨지지 않는다.
    const part = await call(client, 'read_file', { repoId, path: '문서/회의록.md', maxBytes: 12 });
    assert.match(text(part, 0), /"truncated":true/);
    assert.equal(text(part, 1), '# 회의록\n');

    const binary = await ok(client, 'read_file', { repoId, path: 'data.bin' });
    assert.equal(binary.returnedBytes, 0);
    assert.match(binary.note, /download_file/);

    await fails(client, 'read_file', { repoId, path: '없는.txt' }, /HTTP 404/);
  });

  test('이력·버전, 과거 시점 읽기', async () => {
    const client = await connect();
    const { snapshots, next } = await ok(client, 'list_history', { repoId, limit: 2 });
    assert.equal(snapshots.length, 2);
    assert.ok(next && typeof next.before === 'number', '커서는 숫자로 남는다');
    const rest = await ok(client, 'list_history', { repoId, limit: 100, before: next.before, beforeId: next.beforeId });
    assert.equal(snapshots.length + rest.snapshots.length, 4);

    const { versions } = await ok(client, 'list_file_versions', { repoId, path: '문서/회의록.md' });
    assert.deepEqual(versions.map((v: { op: string }) => v.op), ['updated', 'added']);
    const first = await call(client, 'read_file', { repoId, path: '문서/회의록.md', snapshotId: versions[1].snapshotId });
    assert.equal(text(first, 1), '# 회의록\n첫 줄\n');
  });

  test('변경 제안 — 글·이 컴퓨터 파일(여러 조각)·되돌리기·삭제', async () => {
    const client = await connect();
    const { versions } = await ok(client, 'list_file_versions', { repoId, path: '문서/회의록.md' });
    const big = path.join(tmp, 'big.bin');
    const bigBytes = Buffer.alloc(9 * 1024 * 1024 + 123, 7); // 8MB 조각 둘
    fs.writeFileSync(big, bigBytes);

    // 잘못된 항목이 있으면 아무것도 올리지 않고 멈춘다.
    await fails(
      client,
      'propose_changes',
      { repoId, title: 'x', changes: [{ path: 'a.txt', content: 'a', delete: true }] },
      /하나만/,
    );
    await fails(client, 'propose_changes', { repoId, title: 'x', changes: [{ path: 'a.txt', localPath: 'big.bin' }] }, /절대 경로/);

    const created = await ok(client, 'propose_changes', {
      repoId,
      title: 'AI 제안',
      description: '정리',
      changes: [
        { path: '새 메모.md', content: '안녕하세요\n' },
        { path: '자료/big.bin', localPath: big },
        { path: '문서/회의록.md', blobHash: versions[1].blobHash },
        { path: '옛날.txt', delete: true },
      ],
    });
    const { proposal } = created;
    assert.equal(proposal.status, 'open');
    assert.equal(proposal.mergeable, true);
    assert.deepEqual(
      proposal.changes.map((c: { path: string; op: string }) => [c.path, c.op]).sort(),
      [
        ['문서/회의록.md', 'update'],
        ['새 메모.md', 'add'],
        ['옛날.txt', 'delete'],
        ['자료/big.bin', 'add'],
      ],
    );
    // 저장소는 그대로다 — 반영은 편집자가 한다.
    const files = await ok(client, 'list_files', { repoId, recursive: true });
    assert.equal(files.files.length, 3);

    // 제안에 담긴 내용 읽기·받기.
    const memo = await call(client, 'read_file', { repoId, path: '새 메모.md', proposalId: proposal.id });
    assert.equal(text(memo, 1), '안녕하세요\n');
    const saved = await ok(client, 'download_file', {
      repoId,
      path: '자료/big.bin',
      proposalId: proposal.id,
      localPath: path.join(tmp, 'back', 'big.bin'),
    });
    assert.equal(saved.size, bigBytes.length);
    assert.ok(fs.readFileSync(path.join(tmp, 'back', 'big.bin')).equals(bigBytes));

    // 의견·목록·상세.
    const commented = await ok(client, 'add_comment', { proposalId: proposal.id, body: '검토 부탁드립니다' });
    assert.equal(commented.comment.body, '검토 부탁드립니다');
    assert.equal(commented.commentCount, 1);
    const listed = await ok(client, 'list_proposals', { repoId, status: 'open' });
    assert.deepEqual(listed.proposals.map((p: { id: string }) => p.id), [proposal.id]);
    assert.equal(listed.next, null);
    const detail = await ok(client, 'get_proposal', { proposalId: proposal.id });
    assert.equal(detail.proposal.comments.length, 1);
    const mine = await ok(client, 'list_my_proposals');
    assert.deepEqual(mine.proposals.map((p: { repoName: string }) => p.repoName), ['문서함']);
  });

  test('내려받기 — 절대 경로만, overwrite 없이는 덮어쓰지 않는다', async () => {
    const client = await connect();
    const target = path.join(tmp, 'down', '회의록.md');
    const saved = await ok(client, 'download_file', { repoId, path: '문서/회의록.md', localPath: target });
    assert.equal(saved.saved, target);
    assert.equal(fs.readFileSync(target, 'utf8'), '# 회의록\n고친 줄\n');

    fs.writeFileSync(target, '내가 고친 것');
    await fails(client, 'download_file', { repoId, path: '문서/회의록.md', localPath: target }, /이미 있는 파일/);
    assert.equal(fs.readFileSync(target, 'utf8'), '내가 고친 것');
    await ok(client, 'download_file', { repoId, path: '문서/회의록.md', localPath: target, overwrite: true });
    assert.equal(fs.readFileSync(target, 'utf8'), '# 회의록\n고친 줄\n');

    await fails(client, 'download_file', { repoId, path: '문서/회의록.md', localPath: 'rel/x.md' }, /절대 경로/);
    // 없는 파일이면 미리 잡아 둔 자리도 남기지 않는다.
    const missing = path.join(tmp, 'down', '없음.txt');
    await fails(client, 'download_file', { repoId, path: '없음.txt', localPath: missing }, /HTTP 404/);
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'down')), ['회의록.md']);
  });
});

describe('로그인', () => {
  test('토큰이 무효면 아이디·비밀번호로 다시 로그인한다', async () => {
    const client = await connect({ token: 'not-a-valid-token' });
    const info = await ok(client, 'server_info');
    assert.equal(info.account.displayName, 'AI 열람자');
  });

  test('토큰만 있고 무효면 사유를 돌려준다 (토큰은 보이지 않는다)', async () => {
    const client = await connect({ token: 'secret-token-value', credentials: null });
    const result = await call(client, 'list_repos');
    assert.equal(result.isError, true);
    assert.match(text(result), /HTTP 401/);
    assert.doesNotMatch(text(result), /secret-token-value/);
  });

  test('bin 으로 띄우면 stdio 로 말하고, 로그에 비밀을 남기지 않는다', async () => {
    const token = (await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: viewer.email, password: 'password1234' },
    }).then((r) => r.json())) as { token: string };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../bin/listup-mcp.mjs', import.meta.url))],
      env: {
        ...(process.env as Record<string, string>),
        LISTUP_URL: `${baseUrl}/api`,
        LISTUP_TOKEN: token.token,
        LISTUP_USERNAME: viewer.email,
        LISTUP_PASSWORD: 'password1234',
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const info = await ok(client, 'server_info');
      assert.equal(info.account.displayName, 'AI 열람자');
    } finally {
      await client.close();
    }
    assert.match(stderr, /연결했습니다/);
    assert.ok(!stderr.includes(token.token), '토큰이 로그에 찍혔다');
    assert.ok(!stderr.includes('password1234'), '비밀번호가 로그에 찍혔다');
  });

  test('bin — 붙을 수 없으면 stderr 에 사유를 남기고 끝난다', async () => {
    // 테스트 서버가 이 프로세스 안에 있으므로 spawnSync 로 기다리면 서버까지 멈춘다.
    const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [fileURLToPath(new URL('../bin/listup-mcp.mjs', import.meta.url))],
        {
          env: { ...process.env, LISTUP_URL: baseUrl, LISTUP_TOKEN: 'secret-token-value', LISTUP_USERNAME: '', LISTUP_PASSWORD: '' },
          encoding: 'utf8',
          timeout: 30_000,
        },
        (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? null) : 0, stdout, stderr }),
      );
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '', 'stdout 은 프로토콜 전용');
    assert.match(child.stderr, /HTTP 401/);
    assert.ok(!child.stderr.includes('secret-token-value'));
  });

  test("수준 5 미만 서버에서는 '내 제안'이 없다고 알린다", async () => {
    const client = await connect({}, { apiLevel: 4 });
    await fails(client, 'list_my_proposals', {}, /1\.8\.0 이상/);
  });
});
