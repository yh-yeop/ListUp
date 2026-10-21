import type { FileEntry } from '@listup/shared';
import { api } from '../api/client';
import type { RepoFile } from './pure/compare-core';

export { compareFolder, type Comparison, type Match, type RepoFile } from './pure/compare-core';

/**
 * 저장소 폴더와 내 폴더를 파일 이름으로 견준다. 내용(해시)은 보지 않는다 — 크기가 다르면 표시만 한다.
 *
 *   경로로   고른 폴더 안의 경로가 저장소 폴더 안의 경로와 같아야 같은 파일 (앨범/노래.mp3 ↔ 앨범/노래.mp3)
 *   이름만   하위 폴더는 보지 않고 파일 이름만 — 정리 방식이 달라도 되지만 같은 이름이 여러 곳이면 한데 묶인다
 *
 * 이름은 NFC 로 맞춰 견준다(맥·안드로이드가 분해형으로 주는 한글·악센트). 대소문자는 구분한다.
 */

/**
 * 저장소 폴더 아래의 모든 파일. 한 번에 주지 않는 서버(1.2 까지)면 폴더마다 물어 모은다.
 * snapshotId 를 주면 그 과거 시점의 목록.
 */
export async function listRepoFolder(repoId: string, basePath: string, snapshotId?: string): Promise<RepoFile[]> {
  const prefix = basePath ? `${basePath}/` : '';
  const relative = (file: FileEntry): RepoFile => ({ ...file, relativePath: file.path.slice(prefix.length) });

  const { tree } = await api.listFiles(repoId, basePath, snapshotId, { recursive: true });
  if (tree.recursive) return tree.files.map(relative);

  const files: FileEntry[] = [...tree.files];
  const pending = tree.dirs.map((dir) => dir.path);
  while (pending.length > 0) {
    const { tree: sub } = await api.listFiles(repoId, pending.shift()!, snapshotId);
    files.push(...sub.files);
    pending.push(...sub.dirs.map((dir) => dir.path));
  }
  return files.map(relative);
}
