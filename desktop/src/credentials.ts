import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * 로그인 정보 저장소 — 앱(`app/src/lib/credentials.ts`)이 서버마다 이메일·비밀번호를 둔다.
 * 값은 safeStorage(Windows DPAPI — 이 Windows 계정만 풀 수 있다)로 암호화해 base64 로 적는다.
 */

const file = () => path.join(app.getPath('userData'), 'credentials.json');

function readAll(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAll(values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(values));
}

export function credentialsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function getCredential(key: string): string | null {
  const stored = readAll()[key];
  if (typeof stored !== 'string') return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // 다른 Windows 계정에서 옮겨 온 파일 등 — 풀 수 없으면 없는 것으로.
    return null;
  }
}

export function setCredential(key: string, value: string): void {
  const values = readAll();
  values[key] = safeStorage.encryptString(value).toString('base64');
  writeAll(values);
}

export function removeCredential(key: string): void {
  const values = readAll();
  if (!(key in values)) return;
  delete values[key];
  writeAll(values);
}
