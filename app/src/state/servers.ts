import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from '@listup/shared';
import { DEFAULT_API_BASE_URL } from '../api/client';

/**
 * 서버 목록 — 이 기기가 기억하는 서버와, 서버마다 받은 토큰.
 *
 * 계정은 서버마다 따로다(서버끼리는 서로 모른다). 그래서 토큰도 서버마다 따로 들고 있다가,
 * 서버를 고르면 그 서버의 토큰으로 갈아 끼운다. 토큰은 발급한 서버에만 보낸다.
 *
 * 기본 서버 항목은 늘 있고 지울 수 없다. 이 항목은 주소를 저장하지 않고 앱이 정한 기본 주소
 * (DEFAULT_API_BASE_URL)를 매번 따라간다 — 개발 중에는 PC 의 LAN IP 가 바뀔 수 있고,
 * 같은 오리진으로 빌드한 웹에서는 "이 사이트"라서 저장해 둘 주소가 없기 때문이다.
 */

export const DEFAULT_SERVER_ID = 'default';

const STORAGE_KEY = 'listup.servers';
/** 서버 목록 이전의 저장 키. 첫 실행 때 목록으로 옮기고 지운다. */
const LEGACY_KEYS = {
  apiUrl: 'listup.apiUrl',
  token: 'listup.token',
  user: 'listup.user',
} as const;

export interface ServerEntry {
  id: string;
  /** 사용자가 넣은 주소. 기본 서버는 쓰지 않는다(serverUrl 로 읽는다). */
  url: string;
  /** 사용자가 붙인 이름. */
  label: string | null;
  token: string | null;
  /** 마지막으로 확인한 사용자 — 서버에 닿지 못할 때 세션을 잇는 데 쓴다. */
  user: User | null;
  lastUsedAt: number | null;
}

export interface ServerStore {
  version: 1;
  activeId: string;
  servers: ServerEntry[];
}

/** 연결 확인 응답을 기다리는 최대 시간. */
const HEALTH_TIMEOUT_MS = 5_000;

export function isDefaultServer(entry: ServerEntry): boolean {
  return entry.id === DEFAULT_SERVER_ID;
}

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

/** 지금 쓰는 서버. activeId 는 늘 목록 안을 가리키지만, 깨졌을 때를 대비해 기본 서버로 거른다. */
export function activeServer(store: ServerStore): ServerEntry {
  return findServer(store, store.activeId) ?? findServer(store, DEFAULT_SERVER_ID)!;
}

/** 입력한 주소를 정리한다. http(s):// 로 시작하지 않으면 null. 끝 슬래시는 뗀다. */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimmed) ? trimmed : null;
}

/** GET {url}/api/health 가 ok:true 를 돌려주는지 확인한다. 토큰은 보내지 않는다. */
export async function checkServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function newServerId(): string {
  return `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function defaultEntry(): ServerEntry {
  return { id: DEFAULT_SERVER_ID, url: '', label: null, token: null, user: null, lastUsedAt: null };
}

function readUser(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null;
  return typeof (value as Partial<User>).id === 'string' ? (value as User) : null;
}

function readEntry(value: unknown): ServerEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.url !== 'string') return null;
  return {
    id: raw.id,
    url: raw.url,
    label: typeof raw.label === 'string' && raw.label ? raw.label : null,
    token: typeof raw.token === 'string' && raw.token ? raw.token : null,
    user: readUser(raw.user),
    lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : null,
  };
}

/** 저장된 값을 읽어 불변식(기본 서버가 맨 앞에 있다, activeId 가 목록 안이다)을 맞춘다. */
function readStore(raw: string): ServerStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { activeId, servers } = parsed as { activeId?: unknown; servers?: unknown };
  if (!Array.isArray(servers)) return null;

  const seen = new Set<string>();
  const entries: ServerEntry[] = [];
  for (const item of servers) {
    const entry = readEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  const fallback = defaultEntry();
  const found = entries.find(isDefaultServer);
  const rest = entries.filter((entry) => !isDefaultServer(entry));
  const list = [found ?? fallback, ...rest];
  const active =
    typeof activeId === 'string' && list.some((entry) => entry.id === activeId)
      ? activeId
      : DEFAULT_SERVER_ID;
  return { version: 1, activeId: active, servers: list };
}

/**
 * 서버 목록 이전에 쓰던 키 셋(주소·토큰·사용자)을 목록 하나로 옮긴다.
 * 쓰던 사람이 로그아웃되면 안 된다 — 주소를 바꾸지 않았으면 기본 서버에, 바꿨으면 그 주소의
 * 항목에 토큰을 넣고 그 항목을 지금 서버로 둔다.
 */
async function migrateLegacy(): Promise<ServerStore> {
  const pairs = await AsyncStorage.multiGet([
    LEGACY_KEYS.apiUrl,
    LEGACY_KEYS.token,
    LEGACY_KEYS.user,
  ]);
  const values = Object.fromEntries(pairs) as Record<string, string | null>;
  const legacyUrl = values[LEGACY_KEYS.apiUrl]?.replace(/\/+$/, '') || null;
  const token = values[LEGACY_KEYS.token] || null;
  let user: User | null = null;
  try {
    user = readUser(JSON.parse(values[LEGACY_KEYS.user] ?? 'null'));
  } catch {
    user = null;
  }

  const base = defaultEntry();
  if (!legacyUrl || legacyUrl === DEFAULT_API_BASE_URL) {
    return {
      version: 1,
      activeId: DEFAULT_SERVER_ID,
      servers: [{ ...base, token, user: token ? user : null }],
    };
  }
  const custom: ServerEntry = {
    id: newServerId(),
    url: legacyUrl,
    label: null,
    token,
    user: token ? user : null,
    lastUsedAt: token ? Date.now() : null,
  };
  return { version: 1, activeId: custom.id, servers: [base, custom] };
}

/** 서버 목록을 읽는다. 없으면 예전 키에서 옮겨 만든다. */
export async function loadServers(): Promise<ServerStore> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const stored = raw ? readStore(raw) : null;
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
