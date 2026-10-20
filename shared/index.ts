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
  editor: '파일을 직접 올리고 지울 수 있고, 다른 사람의 제안을 반영할 수 있습니다.',
  owner: '저장소 설정과 멤버를 관리할 수 있습니다.',
};

// ---------------------------------------------------------------------------
// 엔티티
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  /** 로그인 아이디. 1.5 까지 "이메일"이라 부르던 칸이라 이름만 email 이다(메일은 보내지 않는다). */
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
  /** 로그인 아이디(필드 이름만 email). 저장소 소유자에게만 보인다. */
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

/** 파일 하나가 어떤 시점에 어떻게 바뀌었는지. GET /repos/:id/files/versions 의 한 줄. */
export interface FileVersion {
  /** 이 변경을 만든 스냅샷. 내용을 받을 때 이 시점을 쓴다(삭제면 받을 것이 없다). */
  snapshotId: string;
  createdAt: number;
  author: PublicUser;
  /** 스냅샷 메시지 (예: "파일 3개 올림", "제안 #2 반영: …"). */
  message: string;
  op: 'added' | 'updated' | 'deleted';
  /** 이 시점 뒤의 내용. 삭제면 null. */
  blobHash: string | null;
  size: number | null;
}

/** 휴지통 — 지워서 지금 저장소에 없는 파일. 지운 뒤 다시 생겼거나 옮긴 것은 빠진다. */
export interface TrashEntry {
  path: string;
  name: string;
  /** 지운 스냅샷. 같은 때 지운 것끼리 묶는 데 쓴다. */
  snapshotId: string;
  /** 지우기 바로 전 시점 — 지운 파일을 받을 때 이 시점을 쓴다. */
  beforeSnapshotId: string;
  message: string;
  deletedAt: number;
  deletedBy: PublicUser;
  /** 지우기 전 내용. 되돌리기는 이 값으로 다시 반영한다. */
  blobHash: string;
  size: number;
  mimeType: string;
}

/** 휴지통에 한 번에 보여 주는 최대 수 (최근 지운 것부터). */
export const MAX_TRASH_ENTRIES = 500;

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
  /** `recursive=1` 로 하위 폴더 파일까지 담았으면 true (dirs 는 비어 있다). 없으면 이 기능이 없는 서버(1.2 까지). */
  recursive?: boolean;
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
  merged: '반영됨',
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
  /** 병합을 막는 경로들 (base 이후 head 에서 바뀐 파일, 또는 head 의 파일/폴더와 이름이 겹치는 경로). */
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
 * - 유니코드 NFC 로 통일 (macOS 는 한글 파일명을 NFD 로 만들어, 같은 이름이 다른 경로가 된다)
 * - 앞뒤 `/` 제거, 중복 `/` 축약, 각 이름의 앞뒤 공백 제거
 * - `.` / `..` 및 제어문자 거부 (경로 탈출 방지)
 * - 제로폭 공백·양방향 제어 같은 유니코드 format 문자 거부 (눈에 안 보이는 다른 이름을 만든다)
 * 유효하지 않으면 null.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  // 윈도우 구분자도 받아준다.
  const raw = input.normalize('NFC').replace(/\\/g, '/').trim();
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (part.length === 0) continue; // 앞뒤·중복 구분자
    // 이름 앞뒤 공백은 화면에서 구분이 안 돼 "a" 와 "a " 가 다른 파일이 되는 혼란을 낳는다.
    const seg = part.trim();
    if (seg.length === 0) return null;
    if (seg === '.' || seg === '..') return null;
    // 제어문자 금지
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
    // format 문자(Cf: 제로폭 공백, RTL 오버라이드 등)는 보이지 않아 같은 이름처럼 보이는 다른 경로를 만든다.
    if (/\p{Cf}/u.test(seg)) return null;
    if (seg.length > 255) return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  if (segments.length > MAX_PATH_SEGMENTS) return null;
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
  return formatDate(new Date(timestamp));
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** `2026.10.20` — 화면에 날짜를 쓸 때 늘 이 모양으로. */
function formatDate(date: Date): string {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

/**
 * 앞으로 올 시각(만료 등) — `오늘 15:20`, `내일 09:00`, 그 밖에는 `2026.10.27 15:20`.
 * 지난 시각은 formatRelativeTime 으로. Intl 을 쓰지 않는다(Hermes 에서 기기마다 다르게 나온다).
 */
export function formatDateTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return `오늘 ${time}`;
  if (sameDay(date, tomorrow)) return `내일 ${time}`;
  return `${formatDate(date)} ${time}`;
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

/**
 * 로그인 아이디 — 서버마다 따로인 계정의 아이디. 글자·숫자로 시작하고 글자·숫자와 `. _ - @ +` 만.
 * 1.5 까지는 이메일 모양만 받았고(메일은 보낸 적 없다) 그렇게 만든 계정도 그대로 쓴다.
 * API·DB 의 필드 이름은 호환을 위해 `email` 그대로다.
 */
export const MIN_LOGIN_ID_LENGTH = 3;
export const MAX_LOGIN_ID_LENGTH = 64;
export const LOGIN_ID_RULE = `${MIN_LOGIN_ID_LENGTH}~${MAX_LOGIN_ID_LENGTH}자, 글자·숫자와 . _ - @ + (글자나 숫자로 시작)`;

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
  | 'too_many_requests'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// 버전
// ---------------------------------------------------------------------------

/**
 * API 호환 버전. 서버와 앱이 서로 알아듣지 못하게 바뀔 때만 올린다 — 필드를 더하는 것처럼
 * 옛 상대가 무시하면 되는 변경에는 올리지 않는다.
 *
 * 서버가 웹을 서빙하던 때는 서버와 앱이 늘 같은 버전이었다. 설치형 클라이언트는 서버와 따로
 * 업데이트되므로, 서버에 들어가기 전에 이 값을 견준다. 이 필드가 없는 서버(1.0.0)는 1 이다.
 */
export const API_VERSION = 1;

/**
 * API 기능 수준. **호환은 깨지 않고** 기능을 더할 때 올린다 — 옛 앱은 이 값을 모르고 그대로 쓴다.
 * 새 앱이 새 기능에 기대게 되면 {@link REQUIRED_SERVER_API_LEVEL} 을 함께 올려, 그 기능이 없는
 * 서버에는 들어가지 않는다. 이 필드가 없는 서버(1.1.0 까지)는 1 이다.
 *
 * - 2 (1.2.0): 나눠 올리기, 여러 파일 커밋, 다운로드 링크·폴더 zip, Range, 비밀번호 재설정
 * - 3 (1.5.0): 파일 버전 목록(`/files/versions`), 휴지통(`/trash`). 없는 서버에서는 앱이 그 화면만 막는다.
 *
 * API_VERSION 을 올리지 않은 이유: 옛 앱(1.1.0)은 API_VERSION 이 같아야만 들어가서, 올리면 멀쩡히
 * 쓸 수 있는 새 서버에서 옛 앱이 모두 막힌다.
 */
export const API_LEVEL = 3;

/** 이 앱이 쓰는 기능이 있는 가장 낮은 서버 API_LEVEL. 앱의 업로드·내려받기가 수준 2 를 쓴다. */
export const REQUIRED_SERVER_API_LEVEL = 2;

/** GET /api/health 응답. 로그인 없이 부를 수 있다. */
export interface HealthResponse {
  ok: true;
  time: number;
  /** 파일 하나의 업로드 한도(바이트). 앱이 업로드 전에 검사하는 데 쓴다. */
  maxUploadBytes: number;
  /** 이 서버가 말하는 API_VERSION. */
  apiVersion: number;
  /** 이 서버의 API_LEVEL. */
  apiLevel: number;
  /** 서버 버전(package.json). 사람에게 보여주는 용도다 — 호환 판단은 apiVersion 으로 한다. */
  version: string;
  /** 서버 주인이 붙인 이름(LISTUP_SERVER_NAME). 정하지 않았으면 null, 1.3.0 까지의 서버에는 없다. */
  serverName?: string | null;
}

// ---------------------------------------------------------------------------
// 전송
// ---------------------------------------------------------------------------

/**
 * 나눠 올리기 한 조각의 크기. 한 요청 본문이 프록시 한도(Cloudflare 100MB)를 넘지 않게 하고,
 * 끊겼을 때 다시 보내는 양을 줄인다. 서버는 이보다 조금 큰 조각까지 받는다.
 */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** 나눠 올리기 세션. received 가 size 에 닿으면 완료할 수 있다. */
export interface UploadSession {
  id: string;
  repoId: string;
  name: string;
  size: number;
  received: number;
  chunkSize: number;
}

/** 올린 파일 내용(blob). 여러 파일 커밋·변경 제안에 hash 로 담는다. */
export interface UploadedBlob {
  hash: string;
  size: number;
  mimeType: string;
  name: string;
}

/** 여러 파일 커밋 결과. */
export interface CommitResult {
  snapshotId: string | null;
  unchanged: boolean;
  added: number;
  updated: number;
  deleted: number;
}

/** 짧게 사는 다운로드 링크. url 은 서버 주소 뒤에 붙이는 경로(/api/dl?t=…)다. */
export interface DownloadLink {
  url: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// PC 앱 — Electron 이 창에 넣어 주는 `window.listupDesktop`
// ---------------------------------------------------------------------------

/** 로그인 정보 저장소. OS 암호화(Windows DPAPI)를 거쳐 저장한다. */
export interface DesktopCredentials {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type HostState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** 공개 주소를 내는 방식. off 면 이 PC·같은 공유기에서만 들어온다. */
export type HostTunnelMode = 'off' | 'tailscale' | 'quick';

export interface HostTunnelStatus {
  /** 고른 방식. 서버가 꺼져 있어도 고른 값이다(켜면 이 방식으로 연다). */
  mode: HostTunnelMode;
  state: 'off' | 'starting' | 'on' | 'error';
  /** 밖에서 들어오는 주소. 켜져 있을 때만. */
  url: string | null;
  /** 사람이 할 일(Funnel 허용 등)이나 실패 이유. */
  message: string | null;
  /** 할 일을 하러 갈 링크 — Tailscale 이 Funnel 허용을 요구할 때. */
  actionUrl: string | null;
}

/** 이 PC 에서 연 서버의 상태. */
export interface HostStatus {
  state: HostState;
  /** state 가 error 일 때의 이유. */
  error: string | null;
  port: number;
  /** 이 PC 에서 들어가는 주소 (http://localhost:<port>). */
  localUrl: string;
  /** 같은 공유기에서 들어오는 주소들. */
  lanUrls: string[];
  tunnel: HostTunnelStatus;
  /** DB·파일이 쌓이는 폴더. */
  dataDir: string;
  /** 앱을 열 때 서버도 켤지. */
  autoStart: boolean;
  /** Windows 에 로그인하면 앱을 (창 없이) 켤지. */
  openAtLogin: boolean;
  /** 서버 이름(LISTUP_SERVER_NAME). 들어오는 사람의 서버 목록에 이 이름으로 보인다. 없으면 null. */
  serverName: string | null;
}

export interface HostSettingsPatch {
  port?: number;
  tunnel?: HostTunnelMode;
  autoStart?: boolean;
  openAtLogin?: boolean;
  /** 빈 문자열이나 null 이면 이름을 지운다. 서버를 다시 켜면 적용된다. */
  serverName?: string | null;
}

/** 공개 방식에 필요한 프로그램이 준비됐는지. */
export interface HostTools {
  tailscale: { installed: boolean; hostname: string | null };
  cloudflared: { installed: boolean };
}

export interface DesktopHost {
  getStatus(): Promise<HostStatus>;
  /** 상태가 바뀔 때마다 부른다. 돌려준 함수로 그만 듣는다. */
  subscribe(listener: (status: HostStatus) => void): () => void;
  start(): Promise<HostStatus>;
  stop(): Promise<HostStatus>;
  update(patch: HostSettingsPatch): Promise<HostStatus>;
  inspectTools(): Promise<HostTools>;
  /** 서버가 켜져 있을 때만. 계정이 없으면 null. */
  issueResetCode(email: string): Promise<{ code: string; expiresAt: number } | null>;
  /** 폴더를 골라 DB 사본과 파일을 담는다. 고르지 않으면 null, 담았으면 그 폴더. */
  backup(): Promise<string | null>;
  /** 서버가 꺼져 있을 때만. 고르지 않으면 그대로. */
  chooseDataFolder(): Promise<HostStatus>;
  openDataFolder(): Promise<void>;
  /** 최근 서버 로그 (오래된 것부터). */
  logs(): Promise<string[]>;
}

/** 내 폴더에 있는 파일 하나. relativePath 는 고른 폴더 안의 경로(`/` 로 나눔). */
export interface LocalFileEntry {
  relativePath: string;
  size: number;
}

/**
 * PC 앱에서 내 폴더를 다룬다 — 고르기·훑기·읽기·쓰기. 창은 절대 경로로 파일을 열 수 없으므로 main 이 대신한다.
 * main 은 이번 실행에서 대화상자로 고른 폴더 안만 다룬다.
 */
export interface DesktopFolders {
  /** 폴더 고르기 대화상자. 취소하면 null. */
  pick(): Promise<{ root: string; name: string } | null>;
  /** 폴더 안의 파일을 모두 훑는다. 너무 많으면 거기서 멈추고 truncated. */
  scan(root: string): Promise<{ entries: LocalFileEntry[]; truncated: boolean }>;
  /** 파일의 offset 부터 length 바이트 (올리기 조각). */
  read(root: string, relativePath: string, offset: number, length: number): Promise<Uint8Array>;
  /** url 을 받아 폴더 안 relativePath 에 쓴다(하위 폴더를 만들고, 같은 이름이 있으면 "이름 (1)"). 쓴 경로를 돌려준다. */
  save(root: string, relativePath: string, url: string): Promise<string>;
}

/**
 * PC 앱 자동 업데이트 상태 (desktop/src/updater.ts).
 * - disabled: 업데이트를 하지 않는 실행(개발 묶음 등) — 앱은 GitHub 릴리즈 페이지 안내로 돌아간다
 * - idle: 아직 확인하지 않았다 / checking: 확인 중 / none: 최신이다
 * - downloading: 새 버전을 받는 중 / ready: 받아 두었다 — 다시 시작하거나 끝낼 때 설치된다
 * - error: 확인·받기에 실패했다
 */
export interface DesktopUpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  /** 받는 중이거나 받아 둔 새 버전. */
  version: string | null;
  /** 받는 중일 때 0~100. */
  percent: number | null;
  error: string | null;
}

export interface DesktopUpdates {
  getState(): Promise<DesktopUpdateState>;
  /** 상태가 바뀔 때마다 부른다. 돌려준 함수로 그만 듣는다. */
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
  /** 지금 확인한다. 새 버전이 있으면 바로 받기 시작한다. */
  check(): Promise<DesktopUpdateState>;
  /** 받아 둔 새 버전을 설치하고 다시 켠다. 켜 둔 서버는 다시 켜진다. */
  install(): Promise<void>;
}

export interface DesktopBridge {
  /** PC 앱 버전. */
  version: string;
  credentials: DesktopCredentials;
  host: DesktopHost;
  folders: DesktopFolders;
  /** 1.7.0 부터. */
  updates?: DesktopUpdates;
}
