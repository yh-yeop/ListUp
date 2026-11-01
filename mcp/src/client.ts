import fsp from 'node:fs/promises';
import {
  UPLOAD_CHUNK_BYTES,
  type FileVersion,
  type HealthResponse,
  type MyProposal,
  type Proposal,
  type ProposalDetail,
  type ProposalStatus,
  type RepoSummary,
  type Snapshot,
  type TreeListing,
  type UploadSession,
  type UploadedBlob,
  type User,
  type Comment,
} from '@listup/shared';

/**
 * ListUp HTTP API 클라이언트 — MCP 도구가 쓰는 얇은 래퍼. 경로·응답 모양은 docs/API.md 를 따른다.
 *
 * 권한 판정은 서버가 한다. 여기서는 토큰을 붙여 보내고 서버가 준 오류 문장을 그대로 돌려줄 뿐 역할을
 * 따로 검사하지 않는다 — AI 에게 줄 권한은 어떤 역할의 계정을 주느냐로 정한다.
 */

/** 서버 오류. 메시지는 서버가 준 사람이 읽을 문장(한국어)이다. 토큰은 담지 않는다. */
export class ListUpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ListUpError';
  }
}

/** history·파일 버전의 다음 페이지 커서. */
export interface TimeCursor {
  before: number;
  beforeId: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface ClientOptions {
  /** 서버 주소. 끝의 `/` 와 `/api` 는 떼고 쓴다. */
  baseUrl: string;
  token?: string | null;
  /** 주면 토큰이 없거나 만료(401)됐을 때 이것으로 로그인한다. */
  credentials?: Credentials | null;
}

/** 내려받기 결과 — 본문 일부와 전체 크기. */
export interface RawFile {
  bytes: Uint8Array;
  /** 서버가 알려준 전체 크기. 모르면 null. */
  totalSize: number | null;
  mimeType: string;
  truncated: boolean;
}

export type FileSource = { repoId: string; path: string; snapshotId?: string } | { proposalId: string; path: string };

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

export class ListUpClient {
  readonly baseUrl: string;
  private token: string | null;
  private readonly credentials: Credentials | null;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token ?? null;
    this.credentials = options.credentials ?? null;
  }

  // ---------------------------------------------------------------------------
  // 요청
  // ---------------------------------------------------------------------------

  private async send(
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<Response> {
    const auth = init.auth ?? true;
    if (auth && this.token === null) await this.login();
    const attempt = () => {
      const headers: Record<string, string> = { ...init.headers };
      if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
      let body: string | Uint8Array | undefined;
      if (init.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.json);
      } else if (init.body !== undefined) {
        headers['content-type'] = 'application/octet-stream';
        body = init.body;
      }
      return fetch(`${this.baseUrl}/api${path}`, { method, headers, body });
    };
    let res = await attempt();
    // 비밀번호로 받은 토큰은 만료(기본 30일)될 수 있다 — 오래 켜 두는 MCP 서버라 한 번 다시 로그인한다.
    if (res.status === 401 && auth && this.credentials) {
      await this.login();
      res = await attempt();
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  private async json<T>(method: string, path: string, json?: unknown, auth = true): Promise<T> {
    const res = await this.send(method, path, { json, auth });
    return (await res.json()) as T;
  }

  private async login(): Promise<void> {
    if (!this.credentials) {
      throw new ListUpError('로그인 정보가 없습니다. LISTUP_TOKEN 이나 아이디·비밀번호를 주세요.', 401, 'unauthorized');
    }
    const { username, password } = this.credentials;
    // email 은 1.5 까지의 서버가 받는 필드 이름, username 은 1.6+ (둘 다 있으면 username).
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: username, username, password }),
    });
    if (!res.ok) throw await toError(res);
    this.token = ((await res.json()) as { token: string }).token;
  }

  // ---------------------------------------------------------------------------
  // 읽기
  // ---------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.json('GET', '/health', undefined, false);
  }

  async me(): Promise<User> {
    return (await this.json<{ user: User }>('GET', '/auth/me')).user;
  }

  async listRepos(): Promise<RepoSummary[]> {
    return (await this.json<{ repos: RepoSummary[] }>('GET', '/repos')).repos;
  }

  async getRepo(repoId: string): Promise<RepoSummary> {
    return (await this.json<{ repo: RepoSummary }>('GET', `/repos/${enc(repoId)}`)).repo;
  }

  async listFiles(repoId: string, opts: { path?: string; snapshotId?: string; recursive?: boolean } = {}): Promise<TreeListing> {
    const search = query({ path: opts.path, snapshot: opts.snapshotId, recursive: opts.recursive ? '1' : undefined });
    return (await this.json<{ tree: TreeListing }>('GET', `/repos/${enc(repoId)}/files${search}`)).tree;
  }

  history(repoId: string, opts: { limit?: number; cursor?: TimeCursor } = {}): Promise<{ snapshots: Snapshot[]; next: TimeCursor | null }> {
    return this.json('GET', `/repos/${enc(repoId)}/history${query({ limit: opts.limit, ...opts.cursor })}`);
  }

  fileVersions(repoId: string, path: string, opts: { limit?: number; cursor?: TimeCursor } = {}): Promise<{ versions: FileVersion[]; next: TimeCursor | null }> {
    return this.json('GET', `/repos/${enc(repoId)}/files/versions${query({ path, limit: opts.limit, ...opts.cursor })}`);
  }

  async listProposals(
    repoId: string,
    opts: { status?: ProposalStatus; limit?: number; before?: number } = {},
  ): Promise<{ proposals: Proposal[]; next: { before: number } | null }> {
    const res = await this.json<{ proposals: Proposal[]; next?: { before: number } | null }>(
      'GET',
      `/repos/${enc(repoId)}/proposals${query(opts)}`,
    );
    // 수준 3 이하 서버는 next 를 보내지 않는다(limit 을 무시하고 전부 준다).
    return { proposals: res.proposals, next: res.next ?? null };
  }

  async getProposal(proposalId: string): Promise<ProposalDetail> {
    return (await this.json<{ proposal: ProposalDetail }>('GET', `/proposals/${enc(proposalId)}`)).proposal;
  }

  async myProposals(limit?: number): Promise<MyProposal[]> {
    return (await this.json<{ proposals: MyProposal[] }>('GET', `/proposals/mine${query({ limit })}`)).proposals;
  }

  private rawPath(source: FileSource): string {
    return 'proposalId' in source
      ? `/proposals/${enc(source.proposalId)}/raw${query({ path: source.path })}`
      : `/repos/${enc(source.repoId)}/raw${query({ path: source.path, snapshot: source.snapshotId })}`;
  }

  /** 파일 앞부분을 최대 `maxBytes` 만큼 받는다 (Range 로 — 큰 파일을 통째로 받지 않게). */
  async readRaw(source: FileSource, maxBytes: number): Promise<RawFile> {
    const res = await this.send('GET', this.rawPath(source), { headers: { range: `bytes=0-${maxBytes - 1}` } });
    const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    let totalSize: number | null = null;
    const range = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    if (range) totalSize = Number(range[1]);
    else if (res.status === 200 && res.headers.get('content-length')) totalSize = Number(res.headers.get('content-length'));
    let bytes = new Uint8Array(await res.arrayBuffer());
    // Range 를 모르는 중간 프록시가 전체를 줄 수도 있다.
    if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes);
    const truncated = totalSize !== null ? totalSize > bytes.length : false;
    return { bytes, totalSize, mimeType, truncated };
  }

  /** 파일 전체를 스트림으로 받는다. */
  async openRaw(source: FileSource): Promise<Response> {
    return this.send('GET', this.rawPath(source));
  }

  // ---------------------------------------------------------------------------
  // 제안
  // ---------------------------------------------------------------------------

  /** 내용을 나눠 올리기(/uploads)로 올려 blob 을 받는다. 편집 권한이 없어도 된다(제안용). */
  async uploadBytes(repoId: string, name: string, bytes: Uint8Array): Promise<UploadedBlob> {
    return this.uploadChunks(repoId, name, bytes.length, async (offset, length) => bytes.subarray(offset, offset + length));
  }

  async uploadFile(repoId: string, name: string, localPath: string): Promise<UploadedBlob> {
    const handle = await fsp.open(localPath, 'r');
    try {
      const { size } = await handle.stat();
      return await this.uploadChunks(repoId, name, size, async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new Error(`올리는 도중 파일이 바뀌었습니다: ${localPath}`);
        return buffer;
      });
    } finally {
      await handle.close();
    }
  }

  private async uploadChunks(
    repoId: string,
    name: string,
    size: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<UploadedBlob> {
    const { upload } = await this.json<{ upload: UploadSession }>('POST', `/repos/${enc(repoId)}/uploads`, { name, size });
    try {
      const chunkSize = Math.min(upload.chunkSize || UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES);
      let offset = upload.received;
      while (offset < size) {
        const chunk = await readChunk(offset, Math.min(chunkSize, size - offset));
        const res = await this.send('PUT', `/uploads/${enc(upload.id)}${query({ offset })}`, { body: chunk });
        offset = ((await res.json()) as { upload: UploadSession }).upload.received;
      }
      return (await this.json<{ blob: UploadedBlob }>('POST', `/uploads/${enc(upload.id)}/complete`)).blob;
    } catch (err) {
      // 반쯤 올린 세션은 GC 도 지우지만, 하루 업로드 한도를 붙잡지 않게 바로 취소한다.
      await this.send('DELETE', `/uploads/${enc(upload.id)}`).catch(() => {});
      throw err;
    }
  }

  async createProposal(
    repoId: string,
    input: { title: string; description?: string; changes: { path: string; blobHash: string | null }[] },
  ): Promise<ProposalDetail> {
    return (await this.json<{ proposal: ProposalDetail }>('POST', `/repos/${enc(repoId)}/proposals`, input)).proposal;
  }

  /** 의견을 달고, 그 제안의 의견 전체를 돌려받는다. */
  async addComment(proposalId: string, body: string): Promise<Comment[]> {
    return (await this.json<{ comments: Comment[] }>('POST', `/proposals/${enc(proposalId)}/comments`, { body })).comments;
  }
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function toError(res: Response): Promise<ListUpError> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error?.message) return new ListUpError(body.error.message, res.status, body.error.code ?? 'unknown', body.error.details);
  } catch {
    // JSON 이 아니면(프록시 오류 화면 등) 상태 코드만 알린다.
  }
  return new ListUpError(`서버가 ${res.status} 로 응답했습니다.`, res.status, 'unknown');
}
