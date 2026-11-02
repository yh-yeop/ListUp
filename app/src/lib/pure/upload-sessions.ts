/**
 * 끊긴 나눠 올리기 세션을 기억하는 규칙 — 플랫폼 import 가 없는 순수 함수(app/test 가 node 에서 바로 불러
 * 검사한다). 저장은 lib/upload-sessions.ts, 쓰는 곳은 lib/transfer.ts 의 uploadInChunks.
 *
 * 연결이 오래 끊겨 올리기를 그만둬도 서버의 세션(받은 데까지의 조각)은 남겨 두고, 같은 파일을 다시 올리면
 * 그 세션에 이어 보낸다. 서버는 offset 만 맞춰 보고 내용은 모르므로, 「같은 파일」 판정이 틀리면 고친 파일의
 * 뒷부분이 옛 앞부분에 붙어 조용히 틀린 파일이 된다. 그래서 키에 경로·크기·고친 시각을 모두 넣고, 고친 시각을
 * 모르면 아예 기억하지 않는다(처음부터 보낸다).
 */

/** 세션을 기억하는 시간 — 서버 GC 가 끊긴 세션을 치우기(하루) 전에 잊는다. */
export const SESSION_TTL_MS = 20 * 60 * 60 * 1000;
/** 기억하는 세션 수. 넘으면 오래된 것부터 잊는다. */
export const MAX_SESSIONS = 200;

/** 키에 쓰는 소스의 모양(api/client 의 UploadSource 가 모두 맞는다). */
export interface SessionSource {
  name: string;
  size: number;
  /** 폴더를 골랐을 때 그 안의 경로. 없으면 이름으로 가른다. */
  relativePath?: string;
  /** 기기에서 마지막으로 고친 때. 없거나 0 이면 같은 파일인지 알 수 없다. */
  lastModified?: number;
}

/** 기억한 세션 하나. at 은 기억한(또는 다시 기억한) 때. */
export interface SessionEntry {
  uploadId: string;
  at: number;
}

/** 키 → 세션. */
export type SessionMemo = Record<string, SessionEntry>;

/**
 * 이 서버·저장소에 이 파일을 올리는 세션의 키. 경로(`relativePath ?? name`, NFC)·크기·고친 시각이 하나라도
 * 다르면 다른 키다 — 폴더 안의 `a/x.txt` 와 `b/x.txt` 도 다르다. 고친 시각을 모르면(없음·0) null:
 * 기억하지도, 이어 가지도 않는다.
 */
export function sessionKey(baseUrl: string, repoId: string, source: SessionSource): string | null {
  const { lastModified } = source;
  if (typeof lastModified !== 'number' || !Number.isFinite(lastModified) || lastModified <= 0) return null;
  const where = (source.relativePath || source.name).normalize('NFC');
  return `${baseUrl}\n${repoId}\n${where}\n${source.size}\n${lastModified}`;
}

/** 저장해 둔 글을 읽는다. 깨졌거나 모양이 다른 항목은 버린다. */
export function parseSessions(raw: string | null): SessionMemo {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const memo: SessionMemo = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<SessionEntry> | null;
    if (entry && typeof entry.uploadId === 'string' && typeof entry.at === 'number') {
      memo[key] = { uploadId: entry.uploadId, at: entry.at };
    }
  }
  return memo;
}

/** 20시간이 지난 것을 잊고, 200개가 넘으면 오래된 것부터 잊는다. */
export function pruneSessions(memo: SessionMemo, now: number): SessionMemo {
  const fresh = Object.entries(memo)
    .filter(([, entry]) => entry.at > now - SESSION_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_SESSIONS);
  return Object.fromEntries(fresh);
}

/** 이 키로 기억한 세션 id. 없거나 오래됐으면 null. */
export function lookupSession(memo: SessionMemo, key: string, now: number): string | null {
  const entry = Object.prototype.hasOwnProperty.call(memo, key) ? memo[key] : undefined;
  return entry && entry.at > now - SESSION_TTL_MS ? entry.uploadId : null;
}

/** 세션을 기억한다(같은 키는 바꿔 쓴다). 정리도 같이 한다. */
export function rememberSession(memo: SessionMemo, key: string, uploadId: string, now: number): SessionMemo {
  return pruneSessions({ ...memo, [key]: { uploadId, at: now } }, now);
}

/** 세션을 잊는다. */
export function forgetSession(memo: SessionMemo, key: string): SessionMemo {
  const next = { ...memo };
  delete next[key];
  return next;
}
