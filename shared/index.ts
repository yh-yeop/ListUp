/**
 * ListUp 공용 타입/유틸.
 * 서버(Node)와 앱(Expo)이 함께 import 하므로 런타임 의존성이 없어야 한다.
 */

// ---------------------------------------------------------------------------
// 권한
// ---------------------------------------------------------------------------

/** 저장소 안에서의 역할. 숫자가 클수록 강한 권한. */
export type Role = 'viewer' | 'editor' | 'owner';

export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export const ROLES: Role[] = ['viewer', 'editor', 'owner'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

/** `role`이 `required` 이상의 권한인지. */
export function hasRole(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '열람',
  editor: '편집',
  owner: '소유자',
};

/** 역할별로 할 수 있는 일 요약 (UI 설명용). */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  viewer: '파일을 보고 내려받을 수 있고, 변경 제안을 올릴 수 있습니다.',
  editor: '파일을 직접 올리고 지울 수 있고, 다른 사람의 제안을 병합할 수 있습니다.',
  owner: '저장소 설정과 멤버를 관리할 수 있습니다.',
};

// ---------------------------------------------------------------------------
// 엔티티
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

/** 다른 사용자에게 노출되는 최소 정보. */
export interface PublicUser {
  id: string;
  displayName: string;
}

export interface Repo {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  headSnapshotId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RepoSummary extends Repo {
  /** 요청한 사용자의 역할. */
  role: Role;
  owner: PublicUser;
  fileCount: number;
  totalSize: number;
  memberCount: number;
  openProposalCount: number;
}

export interface Member {
  userId: string;
  displayName: string;
  email: string | null;
  role: Role;
  joinedAt: number;
}

/** 저장소의 특정 시점 전체 파일 목록 (커밋에 해당). */
export interface Snapshot {
  id: string;
  repoId: string;
  parentId: string | null;
  message: string;
  authorId: string;
  author: PublicUser;
  createdAt: number;
  fileCount: number;
  totalSize: number;
}

export interface FileEntry {
  path: string;
  name: string;
  blobHash: string;
  size: number;
  mimeType: string;
  updatedAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
  fileCount: number;
  totalSize: number;
}

export interface TreeListing {
  path: string;
  snapshotId: string | null;
  dirs: DirEntry[];
  files: FileEntry[];
}

// ---------------------------------------------------------------------------
// 초대
// ---------------------------------------------------------------------------

export interface Invite {
  id: string;
  repoId: string;
  code: string;
  role: Role;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: number | null;
  /** 지금 사용 가능한지 (만료·소진·회수 반영). */
  active: boolean;
}

/** 코드만으로 조회 가능한 미리보기 — 참여 전에 어떤 저장소인지 보여준다. */
export interface InvitePreview {
  code: string;
  role: Role;
  repo: { id: string; name: string; description: string };
  owner: PublicUser;
  memberCount: number;
  fileCount: number;
  /** 이미 멤버라면 현재 역할. */
  currentRole: Role | null;
}

// ---------------------------------------------------------------------------
// 변경 제안
// ---------------------------------------------------------------------------

export type ChangeOp = 'add' | 'update' | 'delete';

export const CHANGE_OP_LABEL: Record<ChangeOp, string> = {
  add: '추가',
  update: '수정',
  delete: '삭제',
};

export interface ProposalChange {
  path: string;
  op: ChangeOp;
  /** delete 인 경우 null. */
  blobHash: string | null;
  size: number;
  mimeType: string | null;
  /** 제안 시점 기준 원본 blob (add 인 경우 null). */
  baseBlobHash: string | null;
  baseSize: number | null;
}

export type ProposalStatus = 'open' | 'merged' | 'closed';

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  open: '검토 중',
  merged: '병합됨',
  closed: '닫힘',
};

export interface Proposal {
  id: string;
  repoId: string;
  number: number;
  title: string;
  description: string;
  status: ProposalStatus;
  author: PublicUser;
  baseSnapshotId: string | null;
  mergedSnapshotId: string | null;
  createdAt: number;
  updatedAt: number;
  changeCount: number;
  commentCount: number;
}

export interface ProposalDetail extends Proposal {
  changes: ProposalChange[];
  comments: Comment[];
  /** 현재 head 기준으로 병합 가능한지. */
  mergeable: boolean;
  /** 병합을 막는 경로들 (base 이후 head 에서 바뀐 파일). */
  conflicts: string[];
}

export interface Comment {
  id: string;
  author: PublicUser;
  body: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 경로 정규화
// ---------------------------------------------------------------------------

export const MAX_PATH_LENGTH = 512;
export const MAX_PATH_SEGMENTS = 24;

/**
 * 저장소 내부 경로를 정규화한다.
 * - 앞뒤 `/` 제거, 중복 `/` 축약
 * - `.` / `..` 및 제어문자 거부 (경로 탈출 방지)
 * 유효하지 않으면 null.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  // 윈도우 구분자도 받아준다.
  const raw = input.replace(/\\/g, '/').trim();
  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    // 제어문자 금지
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
    if (seg.length > 255) return null;
  }
  const joined = segments.join('/');
  if (joined.length > MAX_PATH_LENGTH) return null;
  return joined;
}

/** 디렉터리 경로 정규화. 루트는 빈 문자열. */
export function normalizeDirPath(input: string | null | undefined): string | null {
  if (input === null || input === undefined || input === '' || input === '/') return '';
  return normalizePath(input);
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function extName(path: string): string {
  const name = baseName(path);
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? '' : name.slice(idx + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// 표시용 헬퍼
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '방금 전';
  if (diff < hour) return `${Math.floor(diff / minute)}분 전`;
  if (diff < day) return `${Math.floor(diff / hour)}시간 전`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}일 전`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 초대 코드
// ---------------------------------------------------------------------------

/** 혼동되는 글자(0/O, 1/I/L)를 뺀 알파벳. */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 10;
/** 표시용 그룹 크기: `ABCDE-FGHIJ` */
export const INVITE_GROUP_SIZE = 5;

export function formatInviteCode(code: string): string {
  const clean = code.toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += INVITE_GROUP_SIZE) {
    groups.push(clean.slice(i, i + INVITE_GROUP_SIZE));
  }
  return groups.join('-');
}

/** 사용자가 입력한 초대 코드를 표준형으로 정리한다. 유효하지 않으면 null. */
export function parseInviteCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of clean) {
    if (!INVITE_ALPHABET.includes(ch)) return null;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// 업로드 제한
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const MAX_FILES_PER_REPO = 5000;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;

// ---------------------------------------------------------------------------
// API 에러
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
