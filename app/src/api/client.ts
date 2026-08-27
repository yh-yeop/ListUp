import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { MAX_FILE_SIZE } from '@listup/shared';
import type {
  ApiErrorBody,
  ApiErrorCode,
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
 * 사용자가 서버 주소 화면에서 바꾼 주소는 AsyncStorage(API_URL_STORAGE_KEY)에 저장되고,
 * 앱 시작 시 auth 가 토큰 복원 전에 setApiBaseUrl 로 적용한다.
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
/** 사용자가 바꾼 서버 주소를 저장하는 AsyncStorage 키. */
export const API_URL_STORAGE_KEY = 'listup.apiUrl';

let apiBaseUrl = DEFAULT_API_BASE_URL;

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

/**
 * 화면에 보여줄 서버 주소.
 * 웹을 서버와 같은 오리진으로 빌드하면(`EXPO_PUBLIC_LISTUP_API_URL=/`) 주소가 빈 문자열이라
 * 그대로 쓰면 "서버:" 뒤가 비어 보인다. 그때는 무엇을 보고 있는지 말로 알려준다.
 */
export function describeApiBaseUrl(): string {
  return apiBaseUrl || '이 사이트와 같은 주소';
}

/** 서버 주소를 바꾼다. null 이면 기본값으로 되돌린다. 끝 슬래시는 떼어 낸다. */
export function setApiBaseUrl(url: string | null): void {
  apiBaseUrl = url ? url.replace(/\/+$/, '') : DEFAULT_API_BASE_URL;
  // 업로드 한도는 서버마다 다르므로 주소가 바뀌면 다시 받아온다.
  maxUploadBytesCache = null;
}

/** 서버가 알려준 파일 하나의 업로드 한도(바이트). */
let maxUploadBytesCache: number | null = null;

/**
 * 파일 하나의 업로드 한도(바이트). 실제 한도는 서버 설정(LISTUP_MAX_UPLOAD_MB)이므로
 * 서버(/api/health)에 물어보고, 응답에 값이 없거나 서버에 닿지 못하면 공용 기본값으로 거른다.
 * 최종 판정은 어차피 서버(413)가 한다.
 */
export async function getMaxUploadBytes(): Promise<number> {
  if (maxUploadBytesCache !== null) return maxUploadBytesCache;
  try {
    const health = await request<{ maxUploadBytes?: unknown }>('/api/health');
    if (typeof health.maxUploadBytes === 'number' && health.maxUploadBytes > 0) {
      maxUploadBytesCache = health.maxUploadBytes;
      return health.maxUploadBytes;
    }
  } catch {
    // 일시적 연결 실패 — 기본값으로 진행하고 다음 기회에 다시 물어본다.
  }
  return MAX_FILE_SIZE;
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

let authToken: string | null = null;
/** 토큰이 더는 유효하지 않을 때 호출된다 (자동 로그아웃). */
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
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
  const headers: Record<string, string> = { ...authHeaders() };
  let body: BodyInit | undefined;

  if (options.formData) {
    body = options.formData as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  // 401 판정은 "이 요청에 쓴 토큰" 기준으로 한다. 토큰 복원 전에 나간 요청이
  // 401 로 돌아오는 사이 새 토큰이 들어왔다면 그 토큰을 지우면 안 된다.
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

    if (response.status === 401 && usedToken && authToken === usedToken) {
      authToken = null;
      onUnauthorized?.();
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

/** 업로드용 파일 소스 — 웹에서는 File, 네이티브에서는 uri 기반. */
export type UploadSource =
  | { kind: 'web'; file: File; name: string; size: number }
  | { kind: 'native'; uri: string; name: string; size: number; mimeType: string };

function toFormData(source: UploadSource): FormData {
  const form = new FormData();
  if (source.kind === 'web') {
    form.append('file', source.file, source.name);
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

export const api = {
  // 인증 ------------------------------------------------------------------
  signup: (payload: { email: string; password: string; displayName: string }) =>
    request<{ token: string; user: User }>('/api/auth/signup', { method: 'POST', body: payload }),

  login: (payload: { email: string; password: string }) =>
    request<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: payload }),

  me: () => request<{ user: User }>('/api/auth/me'),

  updateProfile: (payload: { displayName: string }) =>
    request<{ user: User }>('/api/auth/me', { method: 'PATCH', body: payload }),

  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>('/api/auth/password', { method: 'POST', body: payload }),

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
  listFiles: (repoId: string, path = '', snapshotId?: string) => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (snapshotId) params.set('snapshot', snapshotId);
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
    return `${apiBaseUrl}/api/repos/${repoId}/raw?${params.toString()}`;
  },

  proposalFileUrl: (proposalId: string, path: string, inline = false) => {
    const params = new URLSearchParams({ path });
    if (inline) params.set('inline', '1');
    return `${apiBaseUrl}/api/proposals/${proposalId}/raw?${params.toString()}`;
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
  listProposals: (repoId: string, status?: 'open' | 'merged' | 'closed') =>
    request<{ proposals: Proposal[] }>(
      `/api/repos/${repoId}/proposals${status ? `?status=${status}` : ''}`,
    ),

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
