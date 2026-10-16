/**
 * 변경 제안 화면에서 담아 둔 변경 목록 다루기. 한 경로에는 변경 하나만 — 서버는 같은 경로가 두 번
 * 들어 있으면 제안을 받지 않는다(400).
 */

export interface StagedChange {
  key: string;
  path: string;
  /** null 이면 삭제 제안. */
  blobHash: string | null;
  size: number;
  originalName: string;
}

/** 새로 담으려는 경로 중 이미 담겨 있는 것. 고른 순서대로, 겹침 없이. */
export function alreadyStaged(staged: readonly StagedChange[], paths: readonly string[]): string[] {
  const existing = new Set(staged.map((change) => change.path));
  return [...new Set(paths.filter((path) => existing.has(path)))];
}

/**
 * 담은 목록에 새 변경을 더한다. 같은 경로에 이미 담긴 것(삭제 제안 포함)은 새것으로 바꾼다 — 자리는
 * 옛것이 있던 곳 그대로 두어 목록이 뒤섞이지 않게 한다.
 */
export function mergeStaged(staged: readonly StagedChange[], added: readonly StagedChange[]): StagedChange[] {
  const byPath = new Map(added.map((change) => [change.path, change]));
  const merged = staged.map((change) => byPath.get(change.path) ?? change);
  const placed = new Set(staged.map((change) => change.path));
  return [...merged, ...added.filter((change) => !placed.has(change.path))];
}
