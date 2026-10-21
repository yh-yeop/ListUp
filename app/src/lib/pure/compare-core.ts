import type { FileEntry } from '@listup/shared';
import type { LocalEntry } from '../local-folder';

/**
 * 저장소 폴더와 내 폴더의 대조 — 플랫폼 import 가 없는 순수 함수(app/test 가 node 에서 바로 불러 검사한다).
 * 견주는 규칙은 folder-compare.ts 머리말. 앱은 folder-compare.ts 가 다시 내보내는 것을 쓴다.
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
