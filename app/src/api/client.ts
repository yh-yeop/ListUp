import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { MAX_FILE_SIZE } from '@listup/shared';
import type {
  ApiErrorBody,
  ApiErrorCode,
  CommitResult,
  ConflictResolution,
  DownloadLink,
  HealthResponse,
  PublicShare,
  RepoStorage,
  Share,
  ShareKind,
  UploadSession,
  UploadedBlob,
  Invite,
  InvitePreview,
  Member,
  Proposal,
  ProposalDetail,
  RepoSummary,
  Role,
  Snapshot,
  TreeListing,
  User,
} from '@listup/shared';

/**
 * 기본 서버 주소 결정 순서:
 *   1) EXPO_PUBLIC_LISTUP_API_URL 환경변수
 *   2) app.json 의 extra.listupApiUrl
 *   3) Expo 개발 서버의 호스트 (실기기에서 localhost 는 기기 자신을 가리키므로,
 *      개발 중에는 PC 의 LAN IP 를 자동으로 알아낸다)
 *
 * 사용자가 더한 서버는 서버 목록(state/servers.ts)에 저장되고, 어느 서버를 쓸지는
 * auth 가 setApiTarget 으로 주소와 토큰을 함께 적용한다.
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_LISTUP_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  if (hostUri && Platform.OS !== 'web') {
    const host = hostUri.split(':')[0];
    if (host) return `http://${host}:4000`;
  }

  const fromConfig = (Constants.expoConfig?.extra as { listupApiUrl?: string } | undefined)
    ?.listupApiUrl;
  return (fromConfig ?? 'http://localhost:4000').replace(/\/$/, '');
}

export const DEFAULT_API_BASE_URL = resolveBaseUrl();

/**
 * 설치형 클라이언트로 빌드됐는지.
 *
 * 설치형에는 "이 앱을 준 서버"가 없다 — 서버가 꺼져 있어도 켜지고, 서버 목록에서 들어갈 서버를
 * 고른다. 그래서 기본 서버를 두지 않는다.
 *   - 릴리스 네이티브 빌드 (APK)
 *   - EXPO_PUBLIC_LISTUP_CLIENT=1 로 만든 웹 빌드 (PC 앱)
 * 서버가 서빙하는 웹과 개발 중(Expo Go)은 서버 모드다 — 기본 주소가 뜻이 있다.
 */
export const IS_CLIENT_BUILD =
  process.env.EXPO_PUBLIC_LISTUP_CLIENT === '1' || (Platform.OS !== 'web' && !__DEV__);

/** 요청을 보낼 서버. null 이면 아직 고른 서버가 없다(클라이언트 모드). */
let apiBaseUrl: string | null = IS_CLIENT_BUILD ? null : DEFAULT_API_BASE_URL;
let authToken: string | null = null;

/**
 * 요청을 보낼 서버와 그 서버에서 받은 토큰을 함께 바꾼다.
 * 주소와 토큰은 짝이다 — 따로 바꾸면 그 사이에 나간 요청이 한 서버의 토큰을 다른 서버로
 * 보낸다. 그래서 둘을 바꾸는 길은 이 함수 하나뿐이고, 동기 함수라 중간에 끼어들 틈이 없다.
 */
export function setApiTarget(url: string | null, token: string | null): void {
  const nextUrl = url === null ? null : url.replace(/\/+$/, '');
  // 한도·기능 수준은 서버마다 다르므로 주소가 바뀌면 다시 받아온다. 같은 공유기 지름길도 다시 찾는다.
  if (nextUrl !== apiBaseUrl) {
    healthCache = null;
    transferBaseUrl = null;
    lanProbedAt = 0;
  }
  if (token !== authToken) transferBaseUrl = null;
  apiBaseUrl = nextUrl;
  authToken = token;
}

/** 지금 서버의 /api/health. 한 번 받으면 서버를 바꿀 때까지 쓴다. */
let healthCache: Partial<HealthResponse> | null = null;

/** 지금 서버가 알려 준 것 — 받지 못하면 빈 값(옛 서버로 본다). */
export async function getServerInfo(): Promise<Partial<HealthResponse>> {
  if (healthCache) return healthCache;
  try {
    const health = await request<Partial<HealthResponse>>('/api/health');
    healthCache = health;
    return health;
  } catch {
    // 일시적 연결 실패 — 이번에는 모르는 것으로 하고 다음 기회에 다시 물어본다.
    return {};
  }
}

/** 지금 서버의 기능 수준(API_LEVEL)이 level 이상인지. 1.4.0 기능은 4. */
export async function serverSupports(level: number): Promise<boolean> {
  const info = await getServerInfo();
  return (typeof info.apiLevel === 'number' ? info.apiLevel : 1) >= level;
}

/**
 * 파일 하나의 업로드 한도(바이트). 실제 한도는 서버 설정(LISTUP_MAX_UPLOAD_MB)이므로
 * 서버(/api/health)에 물어보고, 응답에 값이 없거나 서버에 닿지 못하면 공용 기본값으로 거른다.
 * 최종 판정은 어차피 서버(413)가 한다.
 */
export async function getMaxUploadBytes(): Promise<number> {
  const info = await getServerInfo();
  return typeof info.maxUploadBytes === 'number' && info.maxUploadBytes > 0 ? info.maxUploadBytes : MAX_FILE_SIZE;
}

// ---------------------------------------------------------------------------
// 같은 공유기 지름길 — 큰 파일은 터널 대신 공유기 안 주소로
// ---------------------------------------------------------------------------

/**
 * 조각 올리기·내려받기를 보낼 주소. 같은 공유기 안에서 서버에 바로 닿으면 그 주소(http://192.168…),
 * 아니면 null(= 늘 쓰는 주소). Funnel 같은 터널은 대역폭이 좁아 집 안에서 큰 파일을 옮길 때 몇 배 느리다.
 * 브라우저(https 로 서빙되는 웹)는 http 주소로 요청할 수 없어 쓰지 않는다 — 폰 앱·PC 앱만.
 */
let transferBaseUrl: string | null = null;
let lanProbedAt = 0;
const LAN_PROBE_EVERY_MS = 2 * 60 * 1000;
const LAN_PROBE_TIMEOUT_MS = 1500;

/** 지름길을 쓰는 중인지 (진행률 카드에 보인다). */
export function usingLanShortcut(): boolean {
  return transferBaseUrl !== null;
}

/**
 * 서버가 알려 준 공유기 안 주소마다 내 토큰으로 /api/auth/me 를 물어, 같은 사용자로 답하는 곳(= 같은 서버 —
 * 토큰은 그 서버만 받는다)을 지름길로 쓴다. 이미 공유기 안 주소로 붙어 있거나 웹이면 하지 않는다.
 * 몇 분에 한 번만 다시 찾는다.
 */
export async function refreshLanShortcut(force = false): Promise<void> {
  if (Platform.OS === 'web' && !isDesktopShell()) return;
  if (!apiBaseUrl || !authToken) return;
  if (!force && Date.now() - lanProbedAt < LAN_PROBE_EVERY_MS) return;
  lanProbedAt = Date.now();
  if (isPrivateAddress(apiBaseUrl)) {
    transferBaseUrl = null;
    return;
  }
  const usedBase = apiBaseUrl;
  const usedToken = authToken;
  try {
    if (!(await serverSupports(4))) return;
    const [{ urls }, me] = await Promise.all([
      request<{ urls: string[] }>('/api/server/lan'),
      request<{ user: User }>('/api/auth/me'),
    ]);
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LAN_PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(`${url}/api/auth/me`, {
          headers: { Authorization: `Bearer ${usedToken}` },
          signal: controller.signal,
        });
        const body = response.ok ? ((await response.json()) as { user?: User }) : null;
        if (body?.user?.id === me.user.id && apiBaseUrl === usedBase && authToken === usedToken) {
          transferBaseUrl = url;
          return;
        }
      } catch {
        // 닿지 않는다 — 다음 주소.
      } finally {
        clearTimeout(timer);
      }
    }
    if (apiBaseUrl === usedBase) transferBaseUrl = null;
  } catch {
    // 지름길은 덤이다 — 못 찾으면 늘 쓰는 주소로.
  }
}

/** 지름길이 끊겼을 때(공유기를 벗어남) 늘 쓰는 주소로 돌아간다. */
function dropLanShortcut(): void {
  transferBaseUrl = null;
  lanProbedAt = Date.now();
}

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && (window as { listupDesktop?: unknown }).listupDesktop !== undefined;
}

function isPrivateAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host.endsWith('.local')) return true;
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 병합 충돌 시 서버가 알려주는 경로 목록. */
  get conflicts(): string[] {
    const details = this.details as { conflicts?: unknown } | undefined;
    return Array.isArray(details?.conflicts) ? (details!.conflicts as string[]) : [];
  }
}

/** 토큰이 더는 유효하지 않을 때 무효가 된 그 토큰으로 호출된다 (자동 로그아웃). */
let onUnauthorized: ((token: string) => void) | null = null;

export function setUnauthorizedHandler(handler: ((token: string) => void) | null): void {
  onUnauthorized = handler;
}

export function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** FormData 를 보낼 때는 Content-Type 을 브라우저/RN 이 정하게 둔다. */
  formData?: FormData;
  signal?: AbortSignal;
}

/** 서버 응답을 기다리는 최대 시간. 파일 업로드(FormData)에는 적용하지 않는다. */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (apiBaseUrl === null) {
    throw new ApiError(0, 'internal', '들어갈 서버를 먼저 골라 주세요.');
  }
  const headers: Record<string, string> = { ...authHeaders() };
  let body: BodyInit | undefined;

  if (options.formData) {
    body = options.formData as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  // 401 판정은 "이 요청에 쓴 서버와 토큰" 기준으로 한다. 요청이 돌아오는 사이 새로
  // 로그인했거나 다른 서버로 옮겼다면, 늦게 온 401 이 지금 세션을 지우면 안 된다.
  const usedBaseUrl = apiBaseUrl;
  const usedToken = authToken;

  // 호출자가 signal 을 주지 않은 일반 요청에는 타임아웃을 건다.
  // (Hermes 에는 AbortSignal.timeout 이 없어 setTimeout + abort 로 만든다.)
  let signal = options.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (!signal && !options.formData) {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  }
  const timeoutError = () =>
    new ApiError(0, 'internal', '서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.');

  try {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal,
      });
    } catch (err) {
      if (timedOut) throw timeoutError();
      throw new ApiError(
        0,
        'internal',
        `서버에 연결할 수 없습니다. (${apiBaseUrl})\n서버가 켜져 있는지 확인해 주세요.`,
        err,
      );
    }

    if (
      response.status === 401 &&
      usedToken &&
      authToken === usedToken &&
      apiBaseUrl === usedBaseUrl
    ) {
      authToken = null;
      onUnauthorized?.(usedToken);
    }

    if (!response.ok) {
      let parsed: ApiErrorBody | null = null;
      try {
        parsed = (await response.json()) as ApiErrorBody;
      } catch {
        // 본문이 JSON 이 아닌 경우 (프록시 오류 등)
      }
      throw new ApiError(
        response.status,
        parsed?.error?.code ?? 'internal',
        parsed?.error?.message ?? `요청이 실패했습니다. (HTTP ${response.status})`,
        parsed?.error?.details,
      );
    }

    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (err) {
      // 본문을 받는 도중 타임아웃이 걸린 경우
      if (timedOut) throw timeoutError();
      throw err;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 업로드용 파일 소스 — 웹에서는 File, 네이티브에서는 uri 기반.
 * relativePath 는 폴더를 통째로 고른 경우 그 폴더 안에서의 경로(맨 위 폴더 이름 포함, 예: `사진/여름/a.jpg`).
 */
export type UploadSource =
  | { kind: 'web'; file: File; name: string; size: number; relativePath?: string }
  | { kind: 'native'; uri: string; name: string; size: number; mimeType: string; relativePath?: string }
  /** PC 앱에서 고른 폴더 안의 파일 — 창은 직접 못 읽고 PC 앱(main)이 조각을 읽어 준다. 나눠 올리기로만. */
  | { kind: 'desktop'; root: string; relativePath: string; name: string; size: number };

/** 사용자가 올리기를 멈춰 보내던 요청을 끊었을 때. 연결 오류(ApiError status 0)와 구별한다. */
export class UploadAbortedError extends Error {
  constructor() {
    super('올리기를 멈췄습니다.');
    this.name = 'UploadAbortedError';
  }
}

/** 조각 하나를 보내는 동안 기다리는 최대 시간. 느린 모바일 망에서 8MB 가 넉넉히 들어가게. */
const CHUNK_TIMEOUT_MS = 120_000;

/**
 * 바이트를 그대로 보내고 JSON 응답을 받는다 — 나눠 올리기 조각용. 보낸 양을 onProgress 로 알려 준다.
 * fetch 는 올리는 진행률을 주지 않아 XMLHttpRequest 를 쓴다(웹·네이티브 모두 있다).
 * 401 처리는 request 와 같다 — 이 요청에 쓴 서버·토큰이 지금과 같을 때만 세션을 지운다.
 */
function sendBytes<T>(
  method: 'PUT' | 'POST',
  path: string,
  bytes: Blob | Uint8Array,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
  /** 공개 링크(받기 함)로 보낼 때: 그 서버 주소, 로그인 토큰은 보내지 않는다. */
  publicBase?: string,
): Promise<T> {
  // 멤버의 조각은 같은 공유기 지름길이 있으면 그리로 보낸다.
  const lan = publicBase ? null : transferBaseUrl;
  const base = publicBase ?? lan ?? apiBaseUrl;
  if (base === null) return Promise.reject(new ApiError(0, 'internal', '들어갈 서버를 먼저 골라 주세요.'));
  if (signal?.aborted) return Promise.reject(new UploadAbortedError());
  const usedBaseUrl = publicBase ?? apiBaseUrl;
  const usedToken = publicBase ? null : authToken;
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // 멈추면 보내던 조각도 바로 끊는다 — 조각 하나(8MB)가 다 갈 때까지 기다리지 않게.
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onabort = () => reject(new UploadAbortedError());
    xhr.onloadend = () => {
      signal?.removeEventListener('abort', onAbort);
      // RN 의 XMLHttpRequest 는 abort 이벤트를 주지 않을 때가 있어 끝날 때 한 번 더 본다(이미 정해졌으면 무시된다).
      if (signal?.aborted) reject(new UploadAbortedError());
    };
    xhr.open(method, `${base}${path}`);
    xhr.timeout = CHUNK_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (usedToken) xhr.setRequestHeader('Authorization', `Bearer ${usedToken}`);
    if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
    const networkError = () => {
      // 지름길이 끊겼으면(공유기를 벗어남) 늘 쓰는 주소로 돌아간다 — 올리기 엔진이 다시 보낼 때 그리로 간다.
      if (lan && transferBaseUrl === lan) dropLanShortcut();
      reject(
        signal?.aborted
          ? new UploadAbortedError()
          : new ApiError(0, 'internal', `서버에 연결할 수 없습니다. (${usedBaseUrl})\n연결을 확인해 주세요.`),
      );
    };
    xhr.onerror = networkError;
    xhr.ontimeout = networkError;
    xhr.onload = () => {
      if (xhr.status === 401 && usedToken && authToken === usedToken && apiBaseUrl === usedBaseUrl) {
        authToken = null;
        onUnauthorized?.(usedToken);
      }
      let parsed: unknown = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // 본문이 JSON 이 아닌 경우 (프록시 오류 등)
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }
      const error = (parsed as ApiErrorBody | null)?.error;
      reject(
        new ApiError(
          xhr.status,
          error?.code ?? 'internal',
          error?.message ?? `요청이 실패했습니다. (HTTP ${xhr.status})`,
          error?.details,
        ),
      );
    };
    // RN 의 XMLHttpRequest 는 Uint8Array 가 아니라 ArrayBuffer 를 받는다. 더 큰 버퍼의 일부를 가리키는
    // 배열이면 그 구간만 떼어 보낸다.
    if (bytes instanceof Uint8Array) {
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      xhr.send((whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer);
    } else {
      xhr.send(bytes);
    }
  });
}

/**
 * 같은 공유기 지름길로 받을 주소 — 지름길이 없으면 null. 받다가 실패하면 {@link forgetLanShortcut} 하고
 * 늘 쓰는 주소({@link resolveApiUrl})로 다시 받는다.
 */
export function resolveTransferUrl(path: string): string | null {
  return transferBaseUrl && path.startsWith('/') ? `${transferBaseUrl}${path}` : null;
}

export function forgetLanShortcut(): void {
  dropLanShortcut();
}

/** 서버가 준 경로(/api/…)를 지금 서버 주소가 붙은 전체 주소로. 이미 전체 주소면 그대로. */
export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${apiBaseUrl ?? ''}${pathOrUrl}`;
}

function toFormData(source: UploadSource): FormData {
  const form = new FormData();
  if (source.kind === 'web') {
    form.append('file', source.file, source.name);
  } else if (source.kind === 'desktop') {
    throw new ApiError(0, 'internal', 'PC 앱 폴더의 파일은 나눠 올리기로만 올립니다.');
  } else {
    // RN 의 FormData 는 {uri, name, type} 형태를 파일로 인식한다.
    form.append('file', {
      uri: source.uri,
      name: source.name,
      type: source.mimeType,
    } as unknown as Blob);
  }
  return form;
}

/** 제안 목록 한 페이지의 개수. */
const PROPOSAL_PAGE_SIZE = 30;

export const api = {
  // 인증 ------------------------------------------------------------------
  signup: (payload: { email: string; password: string; displayName: string }) =>
    request<{ token: string; user: User }>('/api/auth/signup', { method: 'POST', body: payload }),

  login: (payload: { email: string; password: string }) =>
    request<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: payload }),

  /** 서버 운영자가 발급한 재설정 코드로 새 비밀번호를 정한다. 성공하면 바로 로그인된다. */
  resetPassword: (payload: { email: string; code: string; newPassword: string }) =>
    request<{ token: string; user: User }>('/api/auth/reset', { method: 'POST', body: payload }),

  me: () => request<{ user: User }>('/api/auth/me'),

  updateProfile: (payload: { displayName: string }) =>
    request<{ user: User }>('/api/auth/me', { method: 'PATCH', body: payload }),

  /** 성공하면 새 토큰을 준다 — 서버가 이전 토큰을 전부 끊으므로 이 값으로 갈아 끼워야 한다. */
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true; token: string }>('/api/auth/password', { method: 'POST', body: payload }),

  // 저장소 ----------------------------------------------------------------
  listRepos: () => request<{ repos: RepoSummary[] }>('/api/repos'),

  createRepo: (payload: { name: string; description?: string }) =>
    request<{ repo: RepoSummary }>('/api/repos', { method: 'POST', body: payload }),

  getRepo: (repoId: string) => request<{ repo: RepoSummary }>(`/api/repos/${repoId}`),

  updateRepo: (repoId: string, payload: { name?: string; description?: string }) =>
    request<{ repo: RepoSummary }>(`/api/repos/${repoId}`, { method: 'PATCH', body: payload }),

  deleteRepo: (repoId: string) =>
    request<{ ok: true }>(`/api/repos/${repoId}`, { method: 'DELETE' }),

  listMembers: (repoId: string) => request<{ members: Member[] }>(`/api/repos/${repoId}/members`),

  setMemberRole: (repoId: string, userId: string, role: Role) =>
    request<{ members: Member[] }>(`/api/repos/${repoId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
    }),

  removeMember: (repoId: string, userId: string) =>
    request<{ ok: true }>(`/api/repos/${repoId}/members/${userId}`, { method: 'DELETE' }),

  transferOwnership: (repoId: string, userId: string) =>
    request<{ repo: RepoSummary }>(`/api/repos/${repoId}/transfer`, {
      method: 'POST',
      body: { userId },
    }),

  /** 변경 이력. `cursor` 는 이전 응답의 `next` 를 그대로 넘긴다 (더 보기). */
  history: (repoId: string, cursor?: { before: number; beforeId: string } | null) => {
    const params = new URLSearchParams();
    if (cursor) {
      params.set('before', String(cursor.before));
      params.set('beforeId', cursor.beforeId);
    }
    const qs = params.toString();
    return request<{
      snapshots: Snapshot[];
      /** 더 볼 게 있으면 다음 요청에 넘길 커서, 없으면 null. */
      next: { before: number; beforeId: string } | null;
    }>(`/api/repos/${repoId}/history${qs ? `?${qs}` : ''}`);
  },

  // 파일 ------------------------------------------------------------------
  listFiles: (repoId: string, path = '', snapshotId?: string, options: { recursive?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (snapshotId) params.set('snapshot', snapshotId);
    if (options.recursive) params.set('recursive', '1');
    const qs = params.toString();
    return request<{ tree: TreeListing }>(`/api/repos/${repoId}/files${qs ? `?${qs}` : ''}`);
  },

  uploadFile: (repoId: string, path: string, source: UploadSource) =>
    request<{ file: { path: string; size: number }; snapshotId: string; unchanged: boolean }>(
      `/api/repos/${repoId}/files?path=${encodeURIComponent(path)}`,
      { method: 'POST', formData: toFormData(source) },
    ),

  deletePath: (repoId: string, path: string) =>
    request<{ removed: string[]; snapshotId: string }>(
      `/api/repos/${repoId}/files?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),

  movePath: (repoId: string, from: string, to: string) =>
    request<{ moved: number; snapshotId: string }>(`/api/repos/${repoId}/files/move`, {
      method: 'POST',
      body: { from, to },
    }),

  // 나눠 올리기 (lib/transfer.ts 가 쓴다) ----------------------------------
  /**
   * 나눠 올리기 세션을 연다. `hash` 를 주면 이 저장소에 이미 있는 내용일 때 세션 없이 바로 `blob` 을 준다
   * (1.4.0 서버부터 — 옛 서버는 hash 를 모른 채 세션을 연다).
   */
  startUpload: (repoId: string, payload: { name: string; size: number; hash?: string }) =>
    request<{ upload: UploadSession | null; blob?: UploadedBlob }>(`/api/repos/${repoId}/uploads`, {
      method: 'POST',
      body: payload,
    }),

  getUpload: (uploadId: string) => request<{ upload: UploadSession }>(`/api/uploads/${uploadId}`),

  putChunk: (
    uploadId: string,
    offset: number,
    bytes: Blob | Uint8Array,
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal,
  ) =>
    sendBytes<{ upload: UploadSession }>('PUT', `/api/uploads/${uploadId}?offset=${offset}`, bytes, onProgress, signal),

  completeUpload: (uploadId: string) =>
    request<{ blob: UploadedBlob }>(`/api/uploads/${uploadId}/complete`, { method: 'POST' }),

  cancelUpload: (uploadId: string) =>
    request<{ ok: true }>(`/api/uploads/${uploadId}`, { method: 'DELETE' }),

  // 1.4.0 -------------------------------------------------------------------

  /** 과거 시점으로 되돌리기 — path 를 주면 그 폴더·파일만. 새 스냅샷으로 남는다. */
  restore: (repoId: string, snapshotId: string, path?: string) =>
    request<{ snapshotId: string; unchanged: boolean; added: number; updated: number; deleted: number }>(
      `/api/repos/${repoId}/restore`,
      { method: 'POST', body: { snapshotId, ...(path ? { path } : {}) } },
    ),

  /** 충돌 정리 — 충돌 경로마다 mine/theirs/merge. */
  resolveProposal: (proposalId: string, resolutions: Record<string, ConflictResolution>) =>
    request<{ proposal: ProposalDetail }>(`/api/proposals/${proposalId}/resolve`, {
      method: 'POST',
      body: { resolutions },
    }),

  repoStorage: (repoId: string) => request<RepoStorage>(`/api/repos/${repoId}/storage`),

  listShares: (repoId: string) => request<{ shares: Share[] }>(`/api/repos/${repoId}/shares`),

  createShare: (
    repoId: string,
    payload: { kind: ShareKind; path?: string; label?: string; expiresInDays?: number | null; maxUses?: number | null; maxMb?: number },
  ) => request<{ share: Share }>(`/api/repos/${repoId}/shares`, { method: 'POST', body: payload }),

  revokeShare: (shareId: string) => request<{ share: Share }>(`/api/shares/${shareId}`, { method: 'DELETE' }),

  /** 다른 서버의 따라가기 링크로 미러 저장소를 만든다. */
  createMirror: (link: string) =>
    request<{ repo: RepoSummary }>('/api/repos/mirror', { method: 'POST', body: { link } }),

  syncMirror: (repoId: string) =>
    request<{ repo: RepoSummary; result: { changed: boolean; fetched: number; fetchedBytes: number } }>(
      `/api/repos/${repoId}/mirror/sync`,
      { method: 'POST' },
    ),

  stopMirror: (repoId: string) =>
    request<{ repo: RepoSummary }>(`/api/repos/${repoId}/mirror`, { method: 'DELETE' }),

  /** 올려 둔 파일 여러 개를 커밋 하나로 반영한다. blobHash 가 null 이면 삭제. */
  commitFiles: (repoId: string, changes: { path: string; blobHash: string | null }[], message?: string) =>
    request<CommitResult>(`/api/repos/${repoId}/files/commit`, {
      method: 'POST',
      body: { changes, ...(message ? { message } : {}) },
    }),

  /** 로그인 헤더 없이 받을 수 있는 짧게 사는 링크. archive 면 폴더를 zip 으로. */
  downloadLink: (repoId: string, payload: { path: string; snapshot?: string; archive?: boolean }) =>
    request<DownloadLink>(`/api/repos/${repoId}/download-link`, { method: 'POST', body: payload }),

  /** 제안에 담을 파일을 미리 올린다. 저장소 내용은 아직 바뀌지 않는다. */
  uploadBlob: (repoId: string, source: UploadSource) =>
    request<{ blob: { hash: string; size: number; mimeType: string; name: string } }>(
      `/api/repos/${repoId}/blobs`,
      { method: 'POST', formData: toFormData(source) },
    ),

  fileUrl: (repoId: string, path: string, options: { snapshotId?: string; inline?: boolean } = {}) => {
    const params = new URLSearchParams({ path });
    if (options.snapshotId) params.set('snapshot', options.snapshotId);
    if (options.inline) params.set('inline', '1');
    return `${apiBaseUrl ?? ''}/api/repos/${repoId}/raw?${params.toString()}`;
  },

  proposalFileUrl: (proposalId: string, path: string, inline = false) => {
    const params = new URLSearchParams({ path });
    if (inline) params.set('inline', '1');
    return `${apiBaseUrl ?? ''}/api/proposals/${proposalId}/raw?${params.toString()}`;
  },

  // 초대 ------------------------------------------------------------------
  listInvites: (repoId: string) => request<{ invites: Invite[] }>(`/api/repos/${repoId}/invites`),

  createInvite: (repoId: string, payload: { role?: Role; expiresInDays?: number | null; maxUses?: number | null }) =>
    request<{ invite: Invite }>(`/api/repos/${repoId}/invites`, { method: 'POST', body: payload }),

  revokeInvite: (inviteId: string) =>
    request<{ ok: true }>(`/api/invites/${inviteId}`, { method: 'DELETE' }),

  previewInvite: (code: string) =>
    request<{ invite: InvitePreview }>(`/api/invites/${encodeURIComponent(code)}`),

  joinInvite: (code: string) =>
    request<{ repo: RepoSummary; alreadyMember: boolean }>(
      `/api/invites/${encodeURIComponent(code)}/join`,
      { method: 'POST' },
    ),

  // 변경 제안 --------------------------------------------------------------
  /**
   * 제안 목록을 새것부터 `limit` 개씩. `cursor` 는 이전 응답의 `next` 를 그대로 넘긴다 (더 보기).
   * 1.3.0 까지의 서버는 `limit` 을 모르고 전부를 주며 `next` 가 없다 — 없으면 null 로 맞춘다.
   */
  listProposals: async (
    repoId: string,
    status?: 'open' | 'merged' | 'closed',
    cursor?: { before: number } | null,
    limit = PROPOSAL_PAGE_SIZE,
  ) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    params.set('limit', String(limit));
    if (cursor) params.set('before', String(cursor.before));
    const page = await request<{ proposals: Proposal[]; next?: { before: number } | null }>(
      `/api/repos/${repoId}/proposals?${params.toString()}`,
    );
    return { proposals: page.proposals, next: page.next ?? null };
  },

  createProposal: (
    repoId: string,
    payload: { title: string; description?: string; changes: { path: string; blobHash: string | null }[] },
  ) =>
    request<{ proposal: ProposalDetail }>(`/api/repos/${repoId}/proposals`, {
      method: 'POST',
      body: payload,
    }),

  getProposal: (proposalId: string) =>
    request<{ proposal: ProposalDetail }>(`/api/proposals/${proposalId}`),

  commentOnProposal: (proposalId: string, body: string) =>
    request<{ comments: ProposalDetail['comments'] }>(`/api/proposals/${proposalId}/comments`, {
      method: 'POST',
      body: { body },
    }),

  mergeProposal: (proposalId: string) =>
    request<{ proposal: ProposalDetail; snapshotId: string }>(
      `/api/proposals/${proposalId}/merge`,
      { method: 'POST' },
    ),

  closeProposal: (proposalId: string) =>
    request<{ proposal: ProposalDetail }>(`/api/proposals/${proposalId}/close`, { method: 'POST' }),

  reopenProposal: (proposalId: string) =>
    request<{ proposal: ProposalDetail }>(`/api/proposals/${proposalId}/reopen`, { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// 공개 링크 — 로그인 없이 (링크를 연 사람의 화면 app/s/[token].tsx 가 쓴다)
// ---------------------------------------------------------------------------

async function publicRequest<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'internal', '서버에 연결할 수 없습니다.');
  }
  const parsed = (await response.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!response.ok) {
    const error = parsed?.error;
    throw new ApiError(response.status, error?.code ?? 'internal', error?.message ?? `요청이 실패했습니다. (HTTP ${response.status})`, error?.details);
  }
  return parsed as T;
}

/** 공개 링크 하나에 대한 요청들. base 는 링크를 준 서버 주소(보통 지금 페이지의 주소). */
export function publicShareApi(base: string, token: string) {
  const root = `/api/s/${encodeURIComponent(token)}`;
  return {
    info: () => publicRequest<{ share: PublicShare }>(base, root),
    fileUrl: (path: string) => `${base}${root}/raw${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    zipUrl: () => `${base}${root}/zip`,
    startUpload: (payload: { name: string; size: number; hash?: string }) =>
      publicRequest<{ upload: UploadSession | null; blob?: UploadedBlob }>(base, `${root}/uploads`, { method: 'POST', body: payload }),
    getUpload: (uploadId: string) => publicRequest<{ upload: UploadSession }>(base, `${root}/uploads/${uploadId}`),
    putChunk: (uploadId: string, offset: number, bytes: Blob | Uint8Array, onProgress?: (loaded: number) => void, signal?: AbortSignal) =>
      sendBytes<{ upload: UploadSession }>('PUT', `${root}/uploads/${uploadId}?offset=${offset}`, bytes, onProgress, signal, base),
    completeUpload: (uploadId: string) =>
      publicRequest<{ blob: UploadedBlob }>(base, `${root}/uploads/${uploadId}/complete`, { method: 'POST' }),
    cancelUpload: (uploadId: string) => publicRequest<{ ok: true }>(base, `${root}/uploads/${uploadId}`, { method: 'DELETE' }),
    submit: (payload: { name: string; message?: string; files: { path: string; blobHash: string }[] }) =>
      publicRequest<{ ok: true; number: number; files: string[] }>(base, `${root}/submit`, { method: 'POST', body: payload }),
  };
}
