import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createContext, type AppContext } from '../src/context.ts';

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-test-'));
  const config = loadConfig({
    dbPath: path.join(dir, 'test.db'),
    blobDir: path.join(dir, 'blobs'),
    authSecret: 'test-secret-do-not-use-in-production',
    corsOrigin: '*',
    maxUploadBytes: 5 * 1024 * 1024,
    webDir: null,
  });
  const ctx = createContext(config);
  const app = await buildApp(ctx, { logger: false });
  await app.ready();

  return {
    app,
    ctx,
    dir,
    async close() {
      await app.close();
      ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  token: string;
  userId: string;
  displayName: string;
  email: string;
}

let userCounter = 0;

export async function signup(app: FastifyInstance, displayName: string): Promise<Session> {
  userCounter += 1;
  const email = `user${userCounter}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', displayName },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const parsed = res.json() as { token: string; user: { id: string } };
  return { token: parsed.token, userId: parsed.user.id, displayName, email };
}

export function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

/** multipart 요청 본문을 손으로 만든다 (테스트에서 추가 의존성을 피하려고). */
export function multipart(
  fileName: string,
  content: Buffer | string,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----listup${Math.random().toString(36).slice(2)}`;
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, data, tail]);
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  };
}

export interface UploadResult {
  statusCode: number;
  json(): unknown;
}

/** 저장소에 파일을 직접 커밋한다. */
export async function uploadFile(
  app: FastifyInstance,
  session: Session,
  repoId: string,
  filePath: string,
  content: string | Buffer,
) {
  const part = multipart(filePath.split('/').pop()!, content);
  return app.inject({
    method: 'POST',
    url: `/api/repos/${repoId}/files?path=${encodeURIComponent(filePath)}`,
    headers: { ...auth(session), ...part.headers },
    payload: part.body,
  });
}

/** 제안에 쓸 blob 을 올리고 hash 를 돌려준다. */
export async function uploadBlob(
  app: FastifyInstance,
  session: Session,
  repoId: string,
  fileName: string,
  content: string | Buffer,
): Promise<string> {
  const part = multipart(fileName, content);
  const res = await app.inject({
    method: 'POST',
    url: `/api/repos/${repoId}/blobs`,
    headers: { ...auth(session), ...part.headers },
    payload: part.body,
  });
  if (res.statusCode !== 201) throw new Error(`blob upload failed: ${res.body}`);
  return (res.json() as { blob: { hash: string } }).blob.hash;
}

export async function createRepo(
  app: FastifyInstance,
  session: Session,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repos',
    headers: auth(session),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`repo create failed: ${res.body}`);
  return (res.json() as { repo: { id: string } }).repo.id;
}

export async function createInvite(
  app: FastifyInstance,
  session: Session,
  repoId: string,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; code: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/repos/${repoId}/invites`,
    headers: auth(session),
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`invite create failed: ${res.body}`);
  const invite = (res.json() as { invite: { id: string; code: string } }).invite;
  return invite;
}

export async function join(
  app: FastifyInstance,
  session: Session,
  code: string,
): Promise<{ statusCode: number; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/invites/${code}/join`,
    headers: auth(session),
  });
  return { statusCode: res.statusCode, body: res.body };
}
