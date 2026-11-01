import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
// SDK 가 쓰는 zod 와 같은 인스턴스여야 설명·제약이 tools/list 의 JSON Schema 로 옮겨진다(mcp/package.json 의 zod 는
// 루트에 깔린 버전에 맞춘다 — 다른 버전이 따로 깔리면 검증은 되지만 설명이 빠진다. test/mcp.test.ts 가 본다).
import { z } from 'zod/v4';
import type { HealthResponse } from '@listup/shared';
import { ListUpError, type FileSource, type ListUpClient } from './client.ts';
import { requireAbsolute, saveResponse } from './local.ts';

/**
 * MCP 도구 — 1차는 열람자도 쓸 수 있는 읽기와 제안·의견뿐이다(직접 편집·병합·관리는 2차, TODO.md).
 *
 * 무엇을 할 수 있는지는 서버가 그 계정의 역할로 판정한다. 그래서 여기서 역할을 미리 막지 않고, 서버가 준
 * 오류 문장을 그대로 도구 오류로 돌려준다.
 */

/** 나의 제안 목록(`/proposals/mine`)이 생긴 서버 수준. */
const MY_PROPOSALS_API_LEVEL = 5;
/** read_file 이 한 번에 돌려주는 기본·최대 바이트. AI 의 맥락을 한 파일이 다 먹지 않게. */
const READ_DEFAULT_BYTES = 200_000;
const READ_MAX_BYTES = 2_000_000;
/** 한 제안의 변경 수 한도 (서버와 같다, docs/API.md 제한값). */
const MAX_PROPOSAL_CHANGES = 200;
const MAX_COMMENT_LENGTH = 2000;
/** 그림으로 돌려줄 형식 — MCP 클라이언트가 보여 줄 수 있는 것. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const repoId = z.string().min(1).describe('저장소 id (list_repos 의 id)');
const filePath = z.string().min(1).describe('저장소 안의 파일 경로 (예: 문서/회의록.md)');
const snapshotId = z.string().min(1).optional().describe('과거 시점(스냅샷 id, list_history 의 id). 없으면 지금 내용');
const limit = (max: number) => z.number().int().min(1).max(max).optional().describe(`최대 개수 (1~${max})`);
const timeCursor = {
  before: z.number().int().optional().describe('다음 페이지: 앞 응답 next.before'),
  beforeId: z.string().optional().describe('다음 페이지: 앞 응답 next.beforeId'),
};

export function createMcpServer(client: ListUpClient, health: HealthResponse, version: string): McpServer {
  const server = new McpServer(
    { name: 'listup', version },
    {
      instructions:
        'ListUp(초대 코드로 참여하는 파일 공유 저장소)을 다룬다. 저장소 내용을 바꾸고 싶으면 직접 고치지 말고 ' +
        'propose_changes 로 변경 제안을 올린다 — 반영은 저장소의 편집자가 검토 후 한다. 할 수 없는 일은 서버가 ' +
        '이 계정의 역할(보통 열람자)로 막고 이유를 오류로 돌려준다.',
    },
  );

  // --------------------------------------------------------------------------- 읽기

  server.registerTool(
    'server_info',
    {
      title: '서버·계정 정보',
      description: '연결된 ListUp 서버(이름·버전·기능 수준·업로드 한도)와 이 MCP 가 쓰는 계정을 본다.',
      annotations: READ,
    },
    run(async () => {
      const me = await client.me();
      return json({
        server: {
          url: client.baseUrl,
          serverName: health.serverName ?? null,
          version: health.version,
          apiVersion: health.apiVersion,
          apiLevel: health.apiLevel,
          maxUploadBytes: health.maxUploadBytes,
        },
        account: { id: me.id, loginId: me.email, displayName: me.displayName },
      });
    }),
  );

  server.registerTool(
    'list_repos',
    {
      title: '저장소 목록',
      description: '이 계정이 참여 중인 저장소와 각 저장소에서의 역할(viewer/editor/owner)·파일 수·용량·열린 제안 수.',
      annotations: READ,
    },
    run(async () => json({ repos: await client.listRepos() })),
  );

  server.registerTool(
    'get_repo',
    {
      title: '저장소 요약',
      description: '저장소 하나의 요약 — 설명, 내 역할, 소유자, 파일 수, 용량, 멤버 수, 열린 제안 수.',
      inputSchema: { repoId },
      annotations: READ,
    },
    run(async (args) => json({ repo: await client.getRepo(args.repoId) })),
  );

  server.registerTool(
    'list_files',
    {
      title: '파일 목록',
      description:
        '폴더 안의 하위 폴더와 파일(크기·형식·blobHash·수정 시각). recursive 면 하위 폴더 파일까지 모두 files 에 담는다.',
      inputSchema: {
        repoId,
        path: z.string().optional().describe('폴더 경로. 없거나 빈 값이면 저장소 맨 위'),
        snapshotId,
        recursive: z.boolean().optional().describe('하위 폴더의 파일까지 모두'),
      },
      annotations: READ,
    },
    run(async (args) => json(await client.listFiles(args.repoId, args))),
  );

  server.registerTool(
    'read_file',
    {
      title: '파일 읽기',
      description:
        '파일 내용을 읽는다. 텍스트는 글로, PNG·JPEG·GIF·WebP 그림은 그림으로 돌려준다. 그 밖의 형식은 크기·형식만 ' +
        '알려 주니 download_file 로 받는다. 긴 파일은 앞부분 maxBytes 만 읽는다. proposalId 를 주면 그 제안에 담긴 ' +
        '(아직 반영되지 않은) 내용을 읽는다.',
      inputSchema: {
        repoId,
        path: filePath,
        snapshotId,
        proposalId: z.string().min(1).optional().describe('제안 id — 그 제안의 내용을 읽는다 (snapshotId 와 함께 줄 수 없다)'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(READ_MAX_BYTES)
          .optional()
          .describe(`앞에서부터 읽을 최대 바이트 (기본 ${READ_DEFAULT_BYTES}, 최대 ${READ_MAX_BYTES})`),
      },
      annotations: READ,
    },
    run(async (args) => {
      const maxBytes = args.maxBytes ?? READ_DEFAULT_BYTES;
      const raw = await client.readRaw(fileSource(args), maxBytes);
      const meta = {
        path: args.path,
        mimeType: raw.mimeType,
        size: raw.totalSize,
        returnedBytes: raw.bytes.length,
        truncated: raw.truncated,
      };
      if (IMAGE_TYPES.has(raw.mimeType) && !raw.truncated) {
        return {
          content: [
            { type: 'text', text: JSON.stringify(meta) },
            { type: 'image', data: Buffer.from(raw.bytes).toString('base64'), mimeType: raw.mimeType },
          ],
        };
      }
      const text = decodeText(raw.bytes);
      if (text === null) {
        return json({ ...meta, returnedBytes: 0, note: '텍스트가 아닌 파일입니다. download_file 로 이 컴퓨터에 받아 보세요.' });
      }
      const head = raw.truncated
        ? `${JSON.stringify(meta)}\n(앞 ${raw.bytes.length}바이트만 — 더 보려면 maxBytes 를 늘리거나 download_file)`
        : JSON.stringify(meta);
      return { content: [{ type: 'text', text: head }, { type: 'text', text }] };
    }),
  );

  server.registerTool(
    'list_history',
    {
      title: '변경 이력',
      description: '저장소의 스냅샷(커밋) 목록, 최근 것부터. next 가 있으면 before·beforeId 로 이어서 받는다.',
      inputSchema: { repoId, limit: limit(100), ...timeCursor },
      annotations: READ,
    },
    run(async (args) => json(await client.history(args.repoId, { limit: args.limit, cursor: cursorOf(args) }))),
  );

  server.registerTool(
    'list_file_versions',
    {
      title: '파일 버전',
      description:
        '파일 하나를 바꾼 시점들, 최근 것부터 (snapshotId·작성자·added/updated/deleted·blobHash). 옛 내용은 그 ' +
        'snapshotId 로 read_file 하고, 되돌리기는 그 blobHash 로 propose_changes 한다.',
      inputSchema: { repoId, path: filePath, limit: limit(100), ...timeCursor },
      annotations: READ,
    },
    run(async (args) =>
      json(await client.fileVersions(args.repoId, args.path, { limit: args.limit, cursor: cursorOf(args) })),
    ),
  );

  server.registerTool(
    'list_proposals',
    {
      title: '제안 목록',
      description: '저장소의 변경 제안, 번호 큰 것부터. next 가 있으면 before 로 이어서 받는다.',
      inputSchema: {
        repoId,
        status: z.enum(['open', 'merged', 'closed']).optional().describe('open=검토 중, merged=반영됨, closed=닫힘. 없으면 전부'),
        limit: limit(100),
        before: z.number().int().optional().describe('다음 페이지: 앞 응답 next.before (이 번호보다 작은 것부터)'),
      },
      annotations: READ,
    },
    run(async (args) => json(await client.listProposals(args.repoId, args))),
  );

  server.registerTool(
    'get_proposal',
    {
      title: '제안 상세',
      description:
        '제안 하나 — 바뀌는 파일(op·크기·제안 당시 원본 baseBlobHash), 의견, 지금 반영할 수 있는지(mergeable)와 ' +
        '충돌 경로. 제안 쪽 내용은 read_file 에 proposalId 를 주어 읽는다.',
      inputSchema: { proposalId: z.string().min(1).describe('제안 id (list_proposals 의 id)') },
      annotations: READ,
    },
    run(async (args) => json({ proposal: await client.getProposal(args.proposalId) })),
  );

  server.registerTool(
    'list_my_proposals',
    {
      title: '내 제안',
      description:
        '이 계정이 올린 제안, 저장소를 가로질러 최근에 바뀐 것부터. unseen 은 마지막으로 상세를 본 뒤 반영·닫혔거나 남이 의견을 단 것.',
      inputSchema: { limit: limit(100) },
      annotations: READ,
    },
    run(async (args) => {
      if (health.apiLevel < MY_PROPOSALS_API_LEVEL) {
        throw new Error(`이 서버(기능 수준 ${health.apiLevel})에는 '내 제안' 목록이 없습니다. 서버 1.8.0 이상이 필요합니다.`);
      }
      return json({ proposals: await client.myProposals(args.limit) });
    }),
  );

  // --------------------------------------------------------------------------- 내려받기 (이 컴퓨터에 쓴다)

  server.registerTool(
    'download_file',
    {
      title: '파일 내려받기',
      description:
        '파일을 이 컴퓨터의 localPath(절대 경로)에 저장한다. 이미 있으면 overwrite: true 일 때만 덮어쓴다. ' +
        'proposalId 를 주면 그 제안에 담긴 내용을 받는다.',
      inputSchema: {
        repoId,
        path: filePath,
        snapshotId,
        proposalId: z.string().min(1).optional().describe('제안 id — 그 제안의 내용을 받는다 (snapshotId 와 함께 줄 수 없다)'),
        localPath: z.string().min(1).describe('저장할 절대 경로 (폴더가 없으면 만든다)'),
        overwrite: z.boolean().optional().describe('이미 있는 파일을 덮어쓴다 (기본 false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run(async (args) => {
      const target = requireAbsolute(args.localPath);
      const res = await client.openRaw(fileSource(args));
      const size = await saveResponse(res, target, args.overwrite ?? false);
      return json({ saved: target, size });
    }),
  );

  // --------------------------------------------------------------------------- 제안·의견

  server.registerTool(
    'propose_changes',
    {
      title: '변경 제안',
      description:
        '저장소에 바로 쓰지 않고 변경 제안을 올린다 — 편집자가 검토해 반영한다. 각 변경은 content(UTF-8 글), ' +
        'localPath(이 컴퓨터의 파일, 절대 경로), blobHash(이력에 있던 내용으로 되돌리기), delete: true 중 하나. ' +
        '추가·수정·삭제 판정은 서버가 지금 저장소 상태를 보고 한다. 내용은 나눠 올리기로 먼저 올린다.',
      inputSchema: {
        repoId,
        title: z.string().min(1).max(200).describe('제안 제목'),
        description: z.string().max(5000).optional().describe('무엇을 왜 바꾸는지'),
        changes: z
          .array(
            z.object({
              path: filePath,
              content: z.string().optional().describe('새 내용 (UTF-8 텍스트)'),
              localPath: z.string().optional().describe('올릴 이 컴퓨터의 파일 (절대 경로) — 그림 같은 바이너리도'),
              blobHash: z.string().optional().describe('이 저장소 이력에 있던 내용 (list_file_versions 의 blobHash)'),
              delete: z.boolean().optional().describe('true 면 이 경로를 지우자는 제안'),
            }),
          )
          .min(1)
          .max(MAX_PROPOSAL_CHANGES)
          .describe(`바꿀 파일들 (최대 ${MAX_PROPOSAL_CHANGES}개)`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run(async (args) => {
      // 올리기 전에 전부 검사한다 — 몇 개 올린 뒤 잘못된 항목에서 멈추면 하루 업로드 한도만 쓴다.
      const plans = args.changes.map((change, i) => {
        const given = (['content', 'localPath', 'blobHash', 'delete'] as const).filter((key) =>
          key === 'delete' ? change.delete === true : change[key] !== undefined,
        );
        if (given.length !== 1) {
          throw new Error(`changes[${i}] (${change.path}): content·localPath·blobHash·delete 중 하나만 주세요.`);
        }
        if (change.localPath !== undefined) requireAbsolute(change.localPath);
        return { change, kind: given[0] };
      });
      const changes: { path: string; blobHash: string | null }[] = [];
      for (const { change, kind } of plans) {
        const name = path.posix.basename(change.path.replace(/\\/g, '/'));
        let blobHash: string | null;
        if (kind === 'delete') blobHash = null;
        else if (kind === 'blobHash') blobHash = change.blobHash!;
        else if (kind === 'content') blobHash = (await client.uploadBytes(args.repoId, name, Buffer.from(change.content!, 'utf8'))).hash;
        else blobHash = (await client.uploadFile(args.repoId, name, requireAbsolute(change.localPath!))).hash;
        changes.push({ path: change.path, blobHash });
      }
      const proposal = await client.createProposal(args.repoId, {
        title: args.title,
        description: args.description,
        changes,
      });
      return json({
        proposal: {
          id: proposal.id,
          number: proposal.number,
          title: proposal.title,
          status: proposal.status,
          mergeable: proposal.mergeable,
          conflicts: proposal.conflicts,
          changes: proposal.changes.map((c) => ({ path: c.path, op: c.op, size: c.size })),
        },
      });
    }),
  );

  server.registerTool(
    'add_comment',
    {
      title: '의견 달기',
      description: '변경 제안에 의견을 단다.',
      inputSchema: {
        proposalId: z.string().min(1).describe('제안 id'),
        body: z.string().trim().min(1).max(MAX_COMMENT_LENGTH).describe(`의견 (${MAX_COMMENT_LENGTH}자까지)`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run(async (args) => {
      const comments = await client.addComment(args.proposalId, args.body);
      return json({ comment: comments[comments.length - 1], commentCount: comments.length });
    }),
  );

  return server;
}

// ---------------------------------------------------------------------------

function fileSource(args: { repoId: string; path: string; snapshotId?: string; proposalId?: string }): FileSource {
  if (args.proposalId !== undefined) {
    if (args.snapshotId !== undefined) throw new Error('snapshotId 와 proposalId 는 함께 줄 수 없습니다.');
    return { proposalId: args.proposalId, path: args.path };
  }
  return { repoId: args.repoId, path: args.path, snapshotId: args.snapshotId };
}

function cursorOf(args: { before?: number; beforeId?: string }) {
  return args.before !== undefined && args.beforeId !== undefined ? { before: args.before, beforeId: args.beforeId } : undefined;
}

/**
 * UTF-8 텍스트면 글로, 아니면 null. 서버의 Content-Type 은 확장자 화이트리스트라(.md·.ts 도
 * octet-stream 일 수 있다) 형식 대신 내용으로 본다. 잘라 읽어 끝에 걸친 멀티바이트 글자는 stream 으로 넘긴다.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return null;
  }
}

/** 시각(…At, 밀리초)을 ISO 문자열로 — AI 가 읽기 쉽게. 커서(next.before)는 그대로 숫자로 둔다. */
export function present(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /At$/.test(key) && typeof v === 'number' ? new Date(v).toISOString() : present(v),
      ]),
    );
  }
  return value;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(present(value), null, 2) }] };
}

/** 도구 본문을 감싸 오류를 도구 오류(isError)로 — 서버가 준 사유를 그대로 AI 에게 보인다. */
function run<A extends unknown[]>(fn: (...args: A) => Promise<CallToolResult>) {
  return async (...args: A): Promise<CallToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
    }
  };
}

export function describeError(err: unknown): string {
  if (err instanceof ListUpError) {
    const conflicts = (err.details as { conflicts?: string[] } | undefined)?.conflicts;
    const extra = conflicts?.length ? `\n충돌 경로: ${conflicts.join(', ')}` : '';
    const hint = err.status === 403 ? '\n(이 계정의 역할로는 할 수 없습니다. 변경은 propose_changes 로 제안하세요.)' : '';
    return `${err.message} (HTTP ${err.status} ${err.code})${extra}${hint}`;
  }
  return err instanceof Error ? err.message : String(err);
}
