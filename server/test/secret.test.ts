import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AUTH_SECRET_FILE, ensureAuthSecret } from '../src/lib/secret.ts';

describe('ensureAuthSecret', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listup-secret-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('없으면 64자 hex 를 만들고, 다음부터는 같은 키를 읽는다', () => {
    const nested = path.join(dir, 'a', 'b');
    const first = ensureAuthSecret(nested);
    assert.equal(first.created, true);
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    assert.equal(first.file, path.join(nested, AUTH_SECRET_FILE));
    assert.equal(fs.readFileSync(first.file, 'utf8'), `${first.secret}\n`);
    assert.deepEqual(fs.readdirSync(nested), [AUTH_SECRET_FILE], '임시 파일이 남지 않는다');
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);

    const second = ensureAuthSecret(nested);
    assert.deepEqual(second, { ...first, created: false });
  });

  it('옛 스크립트가 만든 키(CRLF·대문자)도 그대로 읽는다', () => {
    const key = 'AB'.repeat(32);
    fs.writeFileSync(path.join(dir, AUTH_SECRET_FILE), `${key}\r\n`);
    assert.equal(ensureAuthSecret(dir).secret, key);
  });

  it('형식이 틀리면 새로 만들지 않고 멈춘다 — 파일은 그대로', () => {
    const file = path.join(dir, AUTH_SECRET_FILE);
    for (const broken of ['', '\n', 'abc123', 'z'.repeat(64), 'a'.repeat(63)]) {
      fs.writeFileSync(file, broken);
      assert.throws(() => ensureAuthSecret(dir), /서명 키 파일이 올바르지 않습니다/);
      assert.equal(fs.readFileSync(file, 'utf8'), broken);
    }
  });
});
