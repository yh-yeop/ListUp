import type { FileEntry } from '@listup/shared';
import { api } from '../api/client';
import type { LocalEntry } from './local-folder';

/**
 * 저장소 폴더와 내 폴더를 파일 이름으로 견준다. 내용(해시)은 보지 않는다 — 크기가 다르면 표시만 한다.
 *
 *   경로로   고른 폴더 안의 경로가 저장소 폴더 안의 경로와 같아야 같은 파일 (앨범/노래.mp3 ↔ 앨범/노래.mp3)
 *   이름만   하위 폴더는 보지 않고 파일 이름만 — 정리 방식이 달라도 되지만 같은 이름이 여러 곳이면 한데 묶인다
 *
 * 이름은 NFC 로 맞춰 견준다(맥·안드로이드가 분해형으로 주는 한글·악센트). 대소문자는 구분한다.
 */

export interface RepoFile extends FileEntry {
  /** 견주는 저장소 폴더 안의 경로. */
  relativePath: string;
}

export interface Match {
  key: string;
  repo: RepoFile[];
  local: LocalEntry[];
  /** 저장소와 내 폴더에 크기가 같은 쌍이 하나도 없다. */
  sizeDiffers: boolean;
}

export interface Comparison {
  both: Match[];
  repoOnly: RepoFile[];
  localOnly: LocalEntry[];
  /** 이름만 견줄 때 같은 이름이 여러 곳에 있어 한데 묶인 이름 수. */
  groupedNames: number;
}

const nfc = (value: string) => value.normalize('NFC');

/** 저장소 폴더 아래의 모든 파일. 한 번에 주지 않는 서버(1.2 까지)면 폴더마다 물어 모은다. */
export async function listRepoFolder(repoId: string, basePath: string): Promise<RepoFile[]> {
  const prefix = basePath ? `${basePath}/` : '';
  const relative = (file: FileEntry): RepoFile => ({ ...file, relativePath: file.path.slice(prefix.length) });

  const { tree } = await api.listFiles(repoId, basePath, undefined, { recursive: true });
  if (tree.recursive) return tree.files.map(relative);

  const files: FileEntry[] = [...tree.files];
  const pending = tree.dirs.map((dir) => dir.path);
  while (pending.length > 0) {
    const { tree: sub } = await api.listFiles(repoId, pending.shift()!);
    files.push(...sub.files);
    pending.push(...sub.dirs.map((dir) => dir.path));
  }
  return files.map(relative);
}

export function compareFolder(repoFiles: RepoFile[], localEntries: LocalEntry[], byName: boolean): Comparison {
  const keyOfRepo = (file: RepoFile) => nfc(byName ? file.name : file.relativePath);
  const keyOfLocal = (entry: LocalEntry) => nfc(byName ? entry.name : entry.relativePath);

  const repoByKey = new Map<string, RepoFile[]>();
  for (const file of repoFiles) {
    const key = keyOfRepo(file);
    repoByKey.set(key, [...(repoByKey.get(key) ?? []), file]);
  }
  const localByKey = new Map<string, LocalEntry[]>();
  for (const entry of localEntries) {
    const key = keyOfLocal(entry);
    localByKey.set(key, [...(localByKey.get(key) ?? []), entry]);
  }

  const both: Match[] = [];
  const repoOnly: RepoFile[] = [];
  let groupedNames = 0;
  for (const [key, repo] of repoByKey) {
    const local = localByKey.get(key);
    if (!local) {
      repoOnly.push(...repo);
      continue;
    }
    const localSizes = new Set(local.map((entry) => entry.size));
    both.push({ key, repo, local, sizeDiffers: !repo.some((file) => localSizes.has(file.size)) });
    if (repo.length > 1 || local.length > 1) groupedNames += 1;
  }
  const localOnly = localEntries.filter((entry) => !repoByKey.has(keyOfLocal(entry)));

  const byPath = <T extends { relativePath: string }>(a: T, b: T) =>
    a.relativePath.localeCompare(b.relativePath, 'ko', { numeric: true });
  both.sort((a, b) => a.key.localeCompare(b.key, 'ko', { numeric: true }));
  repoOnly.sort(byPath);
  localOnly.sort(byPath);
  return { both, repoOnly, localOnly, groupedNames };
}
