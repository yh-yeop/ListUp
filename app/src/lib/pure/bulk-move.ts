/**
 * 여러 파일 한꺼번에 옮기기 — 서버의 이동(`/files/move`)은 한 번에 하나라 고른 수만큼 스냅샷이 생긴다. 대신 여러 파일 커밋
 * (`/files/commit`)에 "새 경로 = 같은 내용(blobHash)" + "옛 경로 = 삭제" 를 담아 스냅샷 하나로 옮긴다. 순수 함수(app/test 가 검사).
 *
 * 커밋은 있는 파일에 쓰면 조용히 덮어쓰므로, 옮길 폴더에 같은 이름이 있으면 옮기지 않고 알린다(clashes). 폴더와 이름이 겹치는
 * 경우도 여기서 거른다. 최종 판정(파일·폴더 이름 겹침 409)은 서버가 한다.
 */

export interface MovableFile {
  path: string;
  name: string;
  blobHash: string;
}

export interface BulkMovePlan {
  changes: { path: string; blobHash: string | null }[];
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
    { path: target(file.name), blobHash: file.blobHash },
    { path: file.path, blobHash: null },
  ]);
  return { changes, unchanged, clashes };
}
