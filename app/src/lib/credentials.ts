import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { DesktopCredentials } from '@listup/shared';
import { desktopBridge as desktopApp } from './desktop';

/**
 * 서버마다 로그인 정보(이메일·비밀번호)를 기기에 저장한다 — 클라이언트의 비밀번호 관리자.
 *
 * 토큰과 달리 비밀번호는 새면 그 서버에서 계속 쓸 수 있으므로 **OS 가 암호화해 주는 곳에만** 둔다.
 *   - 네이티브: expo-secure-store (안드로이드 키 저장소 / iOS 키체인)
 *   - PC 앱: 창에 `window.listupDesktop.credentials` 가 있을 때 (Electron safeStorage 로 암호화)
 *   - 그 밖의 웹(서버가 주는 페이지): 저장하지 않는다. 브라우저 저장소는 평문이라서다 — 브라우저의
 *     비밀번호 관리자에 맡긴다(로그인 입력칸에 autoComplete 가 있다).
 */

export interface SavedLogin {
  email: string;
  /** 자동 로그인이 비밀번호 오류로 실패하면 지우고 이메일만 남긴다. */
  password: string | null;
}

/** PC 앱이 창에 넣어 주는 저장소. OS 암호화를 거쳐 저장한다. */
function desktopBridge(): DesktopCredentials | null {
  return desktopApp()?.credentials ?? null;
}

/** 이 클라이언트에서 로그인 정보를 저장할 수 있는지. */
export function credentialsSupported(): boolean {
  return Platform.OS !== 'web' || desktopBridge() !== null;
}

/** SecureStore 키는 영문·숫자·`.`·`-`·`_` 만 쓸 수 있다. 서버 id 가 그 범위다. */
function keyFor(serverId: string): string {
  return `listup.login.${serverId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

async function readRaw(key: string): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge) return bridge.get(key);
  if (Platform.OS === 'web') return null;
  return SecureStore.getItemAsync(key);
}

async function writeRaw(key: string, value: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) return bridge.set(key, value);
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(key, value);
}

async function removeRaw(key: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) return bridge.remove(key);
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(key);
}

/** 그 서버에 저장된 로그인 정보. 없거나 읽지 못하면 null. */
export async function loadLogin(serverId: string): Promise<SavedLogin | null> {
  if (!credentialsSupported()) return null;
  try {
    const raw = await readRaw(keyFor(serverId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLogin>;
    if (typeof parsed.email !== 'string' || !parsed.email) return null;
    return { email: parsed.email, password: typeof parsed.password === 'string' ? parsed.password : null };
  } catch {
    return null;
  }
}

export async function saveLogin(serverId: string, login: SavedLogin): Promise<void> {
  if (!credentialsSupported()) return;
  await writeRaw(keyFor(serverId), JSON.stringify(login));
}

/** 저장된 로그인 정보를 지운다. 실패해도 조용히 넘어간다(지울 게 없었을 수 있다). */
export async function removeLogin(serverId: string): Promise<void> {
  if (!credentialsSupported()) return;
  try {
    await removeRaw(keyFor(serverId));
  } catch {
    // 없는 키를 지우는 것은 문제가 아니다.
  }
}
