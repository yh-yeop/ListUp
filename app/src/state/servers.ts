import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_VERSION, REQUIRED_SERVER_API_LEVEL, type HealthResponse } from '@listup/shared';
import { DEFAULT_API_BASE_URL, IS_CLIENT_BUILD } from '../api/client';
import { serverUrlCandidates } from '../lib/pure/server-url';
import {
  DEFAULT_SERVER_ID,
  LEGACY_KEYS,
  emptyStore,
  isDefaultServer,
  readStore,
  storeFromLegacy,
  type ServerEntry,
  type ServerStore,
} from '../lib/pure/server-store';

export { DEFAULT_SERVER_ID, isDefaultServer, type ServerEntry, type ServerStore } from '../lib/pure/server-store';

/**
 * 서버 목록 — 이 기기가 기억하는 서버와, 서버마다 받은 토큰.
 *
 * 계정은 서버마다 따로다(서버끼리는 서로 모른다). 그래서 토큰도 서버마다 따로 들고 있다가,
 * 서버를 고르면 그 서버의 토큰으로 갈아 끼운다. 토큰은 발급한 서버에만 보낸다.
 *
 * 서버 모드(서버가 서빙한 웹, 개발 중)에서는 기본 서버 항목이 늘 있고 지울 수 없다. 이 항목은
 * 주소를 저장하지 않고 앱이 정한 기본 주소(DEFAULT_API_BASE_URL)를 매번 따라간다 — 개발 중에는
 * PC 의 LAN IP 가 바뀔 수 있고, 같은 오리진으로 빌드한 웹에서는 "이 사이트"라서 저장해 둘 주소가
 * 없기 때문이다.
 *
 * 클라이언트 모드(설치형, IS_CLIENT_BUILD)에는 기본 서버가 없다. 목록이 비어 있을 수 있고
 * 고른 서버가 없을 수 있다(activeId null).
 */

const STORAGE_KEY = 'listup.servers';
/** 연결 확인 응답을 기다리는 최대 시간. */
const HEALTH_TIMEOUT_MS = 5_000;

/** 요청을 보낼 실제 주소. */
export function serverUrl(entry: ServerEntry): string {
  return isDefaultServer(entry) ? DEFAULT_API_BASE_URL : entry.url;
}

/**
 * 화면에 보여줄 주소.
 * 웹을 서버와 같은 오리진으로 빌드하면(`EXPO_PUBLIC_LISTUP_API_URL=/`) 주소가 빈 문자열이라
 * 그대로 쓰면 비어 보인다. 그때는 무엇을 보고 있는지 말로 알려준다.
 */
export function describeUrl(url: string): string {
  return url || '이 사이트와 같은 주소';
}

/** 목록·로그인 화면에 보여줄 서버 이름. */
export function serverTitle(entry: ServerEntry): string {
  if (entry.label) return entry.label;
  return isDefaultServer(entry) ? '기본 서버' : describeUrl(entry.url);
}

export function findServer(store: ServerStore, id: string): ServerEntry | undefined {
  return store.servers.find((entry) => entry.id === id);
}

/**
 * 지금 쓰는 서버. 서버 모드에서는 늘 있다(activeId 가 깨졌으면 기본 서버로 거른다).
 * 클라이언트 모드에서는 고른 서버가 없으면 null.
 */
export function activeServer(store: ServerStore): ServerEntry | null {
  const found = store.activeId ? findServer(store, store.activeId) : undefined;
  if (found) return found;
  return IS_CLIENT_BUILD ? null : (findServer(store, DEFAULT_SERVER_ID) ?? null);
}

/** 아무것도 저장되지 않았을 때의 목록. */
export function initialStore(): ServerStore {
  return emptyStore(IS_CLIENT_BUILD);
}

/** 입력한 주소를 정리한다. http(s):// 로 시작하지 않으면 null. 끝 슬래시는 뗀다. */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimmed) ? trimmed : null;
}

/**
 * 연결 확인 결과.
 * - ok: 들어갈 수 있다
 * - unreachable: ListUp 서버 응답을 받지 못했다 (꺼짐, 주소 틀림, ListUp 이 아님)
 * - server-older / app-older: 닿았지만 API 버전이 달라, 또는 서버에 이 앱이 쓰는 기능이 없어 들어갈 수 없다
 */
export type ServerCheck =
  | { status: 'ok'; version: string | null; name: string | null }
  | { status: 'unreachable' }
  | { status: 'server-older' | 'app-older'; version: string | null };

/**
 * GET {url}/api/health 로 들어갈 수 있는 서버인지 확인한다. 토큰은 보내지 않는다.
 * 설치형 클라이언트는 서버와 따로 업데이트되므로 API 버전도 견준다.
 */
export async function checkServer(url: string): Promise<ServerCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) return { status: 'unreachable' };
    const body = (await response.json()) as Partial<HealthResponse> | null;
    if (body?.ok !== true) return { status: 'unreachable' };
    const version = typeof body.version === 'string' ? body.version : null;
    // apiVersion 이 없는 서버는 버전 확인을 넣기 전(1.0.0)이라 1 이다.
    const apiVersion = typeof body.apiVersion === 'number' ? body.apiVersion : 1;
    if (apiVersion < API_VERSION) return { status: 'server-older', version };
    if (apiVersion > API_VERSION) return { status: 'app-older', version };
    // apiLevel 이 없는 서버(1.1.0 까지)는 나눠 올리기·다운로드 링크가 없어 이 앱으로는 파일을 주고받지 못한다.
    const apiLevel = typeof body.apiLevel === 'number' ? body.apiLevel : 1;
    if (apiLevel < REQUIRED_SERVER_API_LEVEL) return { status: 'server-older', version };
    // 주인이 정한 서버 이름 — 1.3.0 까지의 서버에는 없다.
    const name = typeof body.serverName === 'string' && body.serverName.trim() ? body.serverName.trim() : null;
    return { status: 'ok', version, name };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_SERVER_PORT, serverUrlCandidates } from '../lib/pure/server-url';

/**
 * 사람이 적은 주소(일부만 적어도 된다)를 실제로 닿는 서버 주소로. 후보를 한꺼번에 확인해 앞에서부터 처음
 * 닿은 것을 고른다 — 차례로 하면 닿지 않는 후보마다 기다려야 한다. 주소가 아니면 null, 아무 데도 안 닿으면
 * 첫 후보와 unreachable.
 */
export async function resolveServer(raw: string): Promise<{ url: string; check: ServerCheck } | null> {
  const candidates = serverUrlCandidates(raw);
  if (candidates.length === 0) return null;
  const checks = await Promise.all(candidates.map((url) => checkServer(url)));
  const index = checks.findIndex((check) => check.status !== 'unreachable');
  return index >= 0 ? { url: candidates[index], check: checks[index] } : { url: candidates[0], check: checks[0] };
}

/** 들어갈 수 없는 서버를 고를 때 던진다. 화면이 이유(check)를 보고 할 일을 정한다. */
export class ServerCheckError extends Error {
  readonly check: ServerCheck;

  constructor(message: string, check: ServerCheck) {
    super(message);
    this.name = 'ServerCheckError';
    this.check = check;
  }
}

/** 연결 확인 결과를 사람에게 보여줄 문장으로. 들어갈 수 있으면 null. */
export function describeCheck(check: ServerCheck, url: string): string | null {
  const version = check.status !== 'unreachable' && check.version ? ` (v${check.version})` : '';
  switch (check.status) {
    case 'ok':
      return null;
    case 'unreachable':
      return `${describeUrl(url)} 에서 ListUp 서버 응답을 받지 못했습니다.\n주소와 서버가 켜져 있는지 확인해 주세요.`;
    case 'server-older':
      return `이 서버${version}는 앱보다 오래된 버전이라 들어갈 수 없습니다.\n서버 주인에게 서버 업데이트를 부탁하세요.`;
    case 'app-older':
      return `이 앱이 서버${version}보다 오래된 버전이라 들어갈 수 없습니다.\n앱을 업데이트해 주세요.`;
  }
}

export function newServerId(): string {
  return `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 서버 목록 이전에 쓰던 키 셋을 읽어 목록 하나로 옮긴다(옮기는 규칙은 storeFromLegacy). */
async function migrateLegacy(): Promise<ServerStore> {
  const pairs = await AsyncStorage.multiGet([
    LEGACY_KEYS.apiUrl,
    LEGACY_KEYS.token,
    LEGACY_KEYS.user,
  ]);
  return storeFromLegacy(Object.fromEntries(pairs), {
    isClient: IS_CLIENT_BUILD,
    defaultUrl: DEFAULT_API_BASE_URL,
    newId: newServerId,
    now: Date.now(),
  });
}

/** 서버 목록을 읽는다. 없으면 예전 키에서 옮겨 만든다. */
export async function loadServers(): Promise<ServerStore> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const stored = raw ? readStore(raw, IS_CLIENT_BUILD) : null;
  if (stored) return stored;

  const migrated = await migrateLegacy();
  // 새 키에 먼저 쓰고, 성공한 뒤에만 예전 키를 지운다. 중간에 끊겨도 다음 실행이 다시 옮긴다.
  await saveServers(migrated);
  try {
    await AsyncStorage.multiRemove(Object.values(LEGACY_KEYS));
  } catch {
    // 지우지 못해도 목록이 이미 있으므로 다시 옮기지 않는다.
  }
  return migrated;
}

export async function saveServers(store: ServerStore): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}
