import { baseName, parentPath } from '@listup/shared';

/**
 * 옮기기 계획 — 고른 파일·폴더를 폴더 하나로 옮길 때 무엇이 어디로 가는지(순수 함수, 단위 테스트).
 * 화면(고르기·끌어다 놓기)과 열람자의 이동 제안이 함께 쓴다.
 */

export interface MoveItem {
  path: string;
  isFolder: boolean;
}

export interface MovePair {
  from: string;
  to: string;
}

/** 고른 것 가운데 다른 고른 폴더 안에 든 것은 뺀다 — 폴더가 옮겨지면 함께 간다. */
export function topLevelOnly(items: MoveItem[]): MoveItem[] {
  const folders = items.filter((item) => item.isFolder).map((item) => item.path);
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return !folders.some((folder) => folder !== item.path && item.path.startsWith(`${folder}/`));
  });
}

export type MovePlan = { ok: true; moves: MovePair[] } | { ok: false; reason: string };

/** 고른 것을 targetDir('' 은 맨 위) 바로 아래로. 이름은 그대로 둔다. */
export function planMoveInto(items: MoveItem[], targetDir: string): MovePlan {
  const top = topLevelOnly(items);
  if (top.length === 0) return { ok: false, reason: '옮길 것을 고르세요.' };
  for (const item of top) {
    if (item.isFolder && (targetDir === item.path || targetDir.startsWith(`${item.path}/`))) {
      return { ok: false, reason: `'${baseName(item.path)}' 폴더를 자기 안으로 옮길 수 없습니다.` };
    }
  }
  const moves = top
    .filter((item) => parentPath(item.path) !== targetDir)
    .map((item) => ({ from: item.path, to: targetDir ? `${targetDir}/${baseName(item.path)}` : baseName(item.path) }));
  if (moves.length === 0) return { ok: false, reason: '이미 그 폴더에 있습니다.' };
  const names = new Set<string>();
  for (const move of moves) {
    if (names.has(move.to)) return { ok: false, reason: `같은 이름이 둘입니다: ${baseName(move.to)}` };
    names.add(move.to);
  }
  return { ok: true, moves };
}

/**
 * 폴더 단위 이동을 파일 단위로 편다 — 변경 제안은 파일마다 적는다. files 는 저장소의 지금 파일 경로들.
 * 돌려주는 것은 `{path: 새 경로, movedFrom: 원래 경로}` (createProposal 의 changes 모양).
 */
export function fileMoves(moves: MovePair[], files: string[]): { path: string; movedFrom: string }[] {
  const out: { path: string; movedFrom: string }[] = [];
  for (const move of moves) {
    const prefix = `${move.from}/`;
    for (const file of files) {
      if (file === move.from) out.push({ path: move.to, movedFrom: file });
      else if (file.startsWith(prefix)) out.push({ path: `${move.to}/${file.slice(prefix.length)}`, movedFrom: file });
    }
  }
  return out;
}

/** 알림·제안 제목에 쓸 한 줄. */
export function describeMoves(moves: MovePair[]): string {
  if (moves.length === 1) return `${moves[0].from} → ${moves[0].to}`;
  const target = parentPath(moves[0].to);
  const same = moves.every((move) => parentPath(move.to) === target);
  return same ? `${moves.length}개 → ${target ? `${target}/` : '(맨 위)'}` : `${moves.length}개`;
}
