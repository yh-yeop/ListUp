/**
 * 여러 파일 한꺼번에 옮기기 — 서버의 이동(`/files/move`)은 한 번에 하나라 고른 수만큼 스냅샷이 생긴다. 대신 여러 파일 커밋
 * (`/files/commit`)에 "새 경로 = 같은 내용(blobHash)" + "옛 경로 = 삭제" 를 담아 스냅샷 하나로 옮긴다. 순수 함수(app/test 가 검사).
 *
 * 커밋은 있는 파일에 쓰면 조용히 덮어쓰므로, 옮길 폴더에 같은 이름이 있으면 옮기지 않고 알린다(clashes). 폴더와 이름이 겹치는
 * 경우도 여기서 거른다. 최종 판정(파일·폴더 이름 겹침 409)은 서버가 한다.
 *
 * 각 변경에 `expect` 를 단다(API_LEVEL 7 서버가 본다): 새 경로는 비어 있어야(null), 옛 경로는 목록에서 본 내용 그대로여야 한다.
 * 목록을 본 뒤 다른 사람이 새 버전을 올렸으면 옛 내용으로 옮겨 새 버전을 머리에서 지우는 대신 서버가 409 로 거절한다.
 */

export interface MovableFile {
  path: string;
  name: string;
  blobHash: string;
}

export interface BulkMovePlan {
  changes: { path: string; blobHash: string | null; expect: string | null }[];
  /** 이미 그 폴더에 있어 옮길 필요가 없는 파일. */
  unchanged: string[];
  /** 옮길 폴더에 같은 이름(파일·폴더)이 있거나, 고른 것끼리 이름이 같아 옮기지 못하는 파일 이름. */
  clashes: string[];
}

/**
 * `dest` 는 정리된 폴더 경로(맨 위면 ''). `taken` 은 옮길 폴더에 지금 있는 파일·폴더 이름 — 옮기는 파일 자신이 그 폴더에
 * 이미 있으면(unchanged) 겹침으로 세지 않는다.
 */
export function planBulkMove(files: MovableFile[], dest: string, taken: Iterable<string>): BulkMovePlan {
  const takenNames = new Set(taken);
  const target = (name: string) => (dest ? `${dest}/${name}` : name);
  const unchanged: string[] = [];
  const clashes: string[] = [];
  const moving: MovableFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.path === target(file.name)) {
      unchanged.push(file.path);
      continue;
    }
    if (takenNames.has(file.name) || seen.has(file.name)) {
      clashes.push(file.name);
      continue;
    }
    seen.add(file.name);
    moving.push(file);
  }
  if (clashes.length > 0) return { changes: [], unchanged, clashes };
  const changes = moving.flatMap((file) => [
    { path: target(file.name), blobHash: file.blobHash, expect: null },
    { path: file.path, blobHash: null, expect: file.blobHash },
  ]);
  return { changes, unchanged, clashes };
}

/** `expect` 를 단 커밋 변경 — 바꾸기 전 내용(expect)과 바꾼 뒤 내용(blobHash)을 둘 다 안다. */
export interface ExpectedChange {
  path: string;
  blobHash: string | null;
  expect: string | null;
}

/**
 * 방금 한 커밋을 되돌리는 커밋 — 각 변경의 바꾼 뒤(blobHash)와 바꾸기 전(expect)을 맞바꾼다. 지운 파일은 같은 내용으로 다시
 * 생기고, 옮긴 파일은 제자리로 돌아온다. `expect` 가 그대로 따라가므로 그 사이 누가 또 바꿨으면 서버가 409 로 거절한다
 * (남의 새 버전을 되돌리기로 덮지 않는다). 내용이 이 저장소 이력에 있어 다시 올리지 않아도 된다.
 */
export function invertChanges(changes: ExpectedChange[]): ExpectedChange[] {
  return changes.map((change) => ({ path: change.path, blobHash: change.expect, expect: change.blobHash }));
}

/** `files/commit` 의 `expect` 를 아는 서버의 API 수준. 더 옛 서버는 그 필드를 조용히 무시한다. */
export const EXPECT_API_LEVEL = 7;

/**
 * 「되돌리기」를 줄지 — 되돌리기 커밋은 `expect` 덕에 그 사이 바뀐 파일을 덮지 않는다. `expect` 를 무시하는 옛 서버(수준 6 이하)에서는
 * 그 사이 생긴 같은 이름 파일을 덮거나 옮긴 뒤 고친 새 버전을 지울 수 있으니 버튼을 주지 않는다(휴지통은 그대로). 수준을 모르면
 * (health 에 닿지 못함) 주지 않는다.
 */
export function canUndoByCommit(apiLevel: number | null): boolean {
  return apiLevel !== null && apiLevel >= EXPECT_API_LEVEL;
}

/**
 * 409 의 `details.stale`(그 사이 바뀐 경로)을 사람이 읽을 한 줄로 — "a.txt, 사진/b.jpg 외 2개". 서버 문구는 "바뀐 파일이 있어"까지만
 * 말해, 파일이 많은 폴더에서는 어느 것인지 다시 찾아야 했다. stale 이 없으면(옛 서버·다른 409) undefined.
 */
export function describeStale(details: unknown, max = 3): string | undefined {
  const stale = (details as { stale?: unknown } | null | undefined)?.stale;
  if (!Array.isArray(stale)) return undefined;
  const paths = stale.filter((item): item is string => typeof item === 'string');
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `바뀐 파일: ${shown} 외 ${paths.length - max}개` : `바뀐 파일: ${shown}`;
}
