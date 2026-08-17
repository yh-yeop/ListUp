import Constants from 'expo-constants';
import { Platform } from 'react-native';
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
 * 서버 주소 결정 순서:
 *   1) EXPO_PUBLIC_LISTUP_API_URL 환경변수
 *   2) app.json 의 extra.listupApiUrl
 *   3) Expo 개발 서버의 호스트 (실기기에서 localhost 는 기기 자신을 가리키므로,
 *      개발 중에는 PC 의 LAN IP 를 자동으로 알아낸다)
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

export const API_BASE_URL = resolveBaseUrl();

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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  let body: BodyInit | undefined;

  if (options.formData) {
    body = options.formData as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiError(
      0,
      'internal',
      `서버에 연결할 수 없습니다. (${API_BASE_URL})\n서버가 켜져 있는지 확인해 주세요.`,
      err,
    );
  }

  if (response.status === 401 && authToken) {
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
  return (await response.json()) as T;
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

  history: (repoId: string) =>
    request<{ snapshots: Snapshot[]; nextBefore: number | null }>(`/api/repos/${repoId}/history`),

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
    return `${API_BASE_URL}/api/repos/${repoId}/raw?${params.toString()}`;
  },

  proposalFileUrl: (proposalId: string, path: string, inline = false) => {
    const params = new URLSearchParams({ path });
    if (inline) params.set('inline', '1');
    return `${API_BASE_URL}/api/proposals/${proposalId}/raw?${params.toString()}`;
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
