import type { User } from '@listup/shared';

/**
 * 서버 목록의 모양과, 저장된 값·예전 키를 목록으로 읽는 규칙 — 플랫폼 import 가 없는 순수 함수(app/test 가
 * node 에서 바로 불러 검사한다). 저장(AsyncStorage)과 기본 주소·빌드 모드는 state/servers.ts 가 넘겨준다.
 */

export const DEFAULT_SERVER_ID = 'default';

/** 서버 목록 이전의 저장 키. 첫 실행 때 목록으로 옮기고 지운다. */
export const LEGACY_KEYS = {
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
  /**
   * 이 서버에서 직접 로그아웃했는지. 그러면 저장된 로그인 정보로 자동 로그인하지 않는다 — 다른
   * 계정으로 들어갈 길을 남긴다. 다시 로그인하면 꺼진다.
   */
  signedOut: boolean;
}

export interface ServerStore {
  version: 1;
  /** 지금 서버. 클라이언트 모드에서는 아직 고르지 않았으면 null. */
  activeId: string | null;
  servers: ServerEntry[];
}

export function isDefaultServer(entry: ServerEntry): boolean {
  return entry.id === DEFAULT_SERVER_ID;
}

/** 아무것도 저장되지 않았을 때의 목록. 클라이언트 모드(isClient)에는 기본 서버가 없다. */
export function emptyStore(isClient: boolean): ServerStore {
  return isClient
    ? { version: 1, activeId: null, servers: [] }
    : { version: 1, activeId: DEFAULT_SERVER_ID, servers: [defaultEntry()] };
}

function defaultEntry(): ServerEntry {
  return {
    id: DEFAULT_SERVER_ID,
    url: '',
    label: null,
    token: null,
    user: null,
    lastUsedAt: null,
    signedOut: false,
  };
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
    signedOut: raw.signedOut === true,
  };
}

/**
 * 저장된 값을 읽어 불변식을 맞춘다 — activeId 는 목록 안을 가리킨다. 서버 모드에서는 기본 서버가
 * 맨 앞에 있고, 클라이언트 모드에서는 기본 서버가 없다. 읽을 수 없으면 null(예전 키에서 옮긴다).
 */
export function readStore(raw: string, isClient: boolean): ServerStore | null {
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
  const rest = entries.filter((entry) => !isDefaultServer(entry));
  const list = isClient ? rest : [entries.find(isDefaultServer) ?? defaultEntry(), ...rest];
  const valid = typeof activeId === 'string' && list.some((entry) => entry.id === activeId);
  const active = valid ? (activeId as string) : isClient ? null : DEFAULT_SERVER_ID;
  return { version: 1, activeId: active, servers: list };
}

export interface LegacyContext {
  /** 설치형 클라이언트 빌드인지(IS_CLIENT_BUILD). */
  isClient: boolean;
  /** 앱이 정한 기본 서버 주소(DEFAULT_API_BASE_URL). */
  defaultUrl: string;
  newId: () => string;
  now: number;
}

/**
 * 서버 목록 이전에 쓰던 키 셋(주소·토큰·사용자 — LEGACY_KEYS 이름 → 값)을 목록 하나로 옮긴다.
 * 쓰던 사람이 로그아웃되면 안 된다 — 주소를 바꾸지 않았으면 기본 서버에, 바꿨으면 그 주소의
 * 항목에 토큰을 넣고 그 항목을 지금 서버로 둔다.
 */
export function storeFromLegacy(values: Record<string, string | null>, context: LegacyContext): ServerStore {
  const legacyUrl = values[LEGACY_KEYS.apiUrl]?.replace(/\/+$/, '') || null;
  const token = values[LEGACY_KEYS.token] || null;
  let user: User | null = null;
  try {
    user = readUser(JSON.parse(values[LEGACY_KEYS.user] ?? 'null'));
  } catch {
    user = null;
  }

  const base = defaultEntry();
  if (!legacyUrl || legacyUrl === context.defaultUrl) {
    // 클라이언트 모드에는 기본 서버가 없다. 주소를 바꾼 적이 없다면 옮길 서버도 없다.
    if (context.isClient) return emptyStore(true);
    return {
      version: 1,
      activeId: DEFAULT_SERVER_ID,
      servers: [{ ...base, token, user: token ? user : null }],
    };
  }
  const custom: ServerEntry = {
    id: context.newId(),
    url: legacyUrl,
    label: null,
    token,
    user: token ? user : null,
    lastUsedAt: token ? context.now : null,
    signedOut: false,
  };
  return { version: 1, activeId: custom.id, servers: context.isClient ? [custom] : [base, custom] };
}
