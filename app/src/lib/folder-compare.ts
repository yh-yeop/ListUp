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

// ---------------------------------------------------------------------------
// 내용으로 확인 — 이름 비교 위에 해시를 얹는다
// ---------------------------------------------------------------------------

/**
 * 해시를 계산해 볼 내 폴더 파일 — 이름이 같고 크기도 같은 짝(내용이 같은지 아직 모름)과, 내 폴더에만 있지만
 * 저장소 어딘가에 같은 크기가 있는 파일(옮겼거나 이름만 바꿨을 수 있음). 크기가 다르면 내용도 다르므로 계산하지 않는다.
 */
export function hashCandidates(comparison: Comparison, allRepoFiles: RepoFile[]): LocalEntry[] {
  const sizes = new Set(allRepoFiles.map((file) => file.size));
  const picked = new Map<string, LocalEntry>();
  for (const match of comparison.both) {
    if (match.sizeDiffers) continue;
    for (const entry of match.local) picked.set(entry.relativePath, entry);
  }
  for (const entry of comparison.localOnly) {
    if (sizes.has(entry.size)) picked.set(entry.relativePath, entry);
  }
  return [...picked.values()];
}

export interface ContentFindings {
  /** "둘 다" 중 내용까지 같은 것 (Match.key). */
  identical: Set<string>;
  /** "둘 다" 중 이름은 같은데 내용이 다른 것 (크기가 다른 것 포함). */
  differs: Set<string>;
  /** 위치·이름만 다른 같은 파일 — 내 폴더에만 있는 것과 저장소에만 있는 것의 내용이 같다. */
  moved: { local: LocalEntry; repo: RepoFile }[];
  /** 내 폴더에만 있지만 저장소의 다른 곳(이미 짝이 있는 파일)에 같은 내용이 있다 — 올릴 필요가 없다. */
  alreadyInRepo: { local: LocalEntry; repo: RepoFile }[];
}

/**
 * 해시로 비교 결과를 다시 읽는다. localHashes 는 내 폴더 경로 → sha256 (hashCandidates 의 것만 있어도 된다).
 * 저장소 파일의 해시는 서버가 준 blobHash.
 */
export function contentFindings(
  comparison: Comparison,
  localHashes: Map<string, string>,
  allRepoFiles: RepoFile[],
): ContentFindings {
  const findings: ContentFindings = { identical: new Set(), differs: new Set(), moved: [], alreadyInRepo: [] };
  for (const match of comparison.both) {
    if (match.sizeDiffers) {
      findings.differs.add(match.key);
      continue;
    }
    const repoHashes = new Set(match.repo.map((file) => file.blobHash));
    const hashes = match.local.map((entry) => localHashes.get(entry.relativePath));
    if (hashes.some((hash) => hash === undefined)) continue; // 아직 모른다
    if (hashes.some((hash) => repoHashes.has(hash!))) findings.identical.add(match.key);
    else findings.differs.add(match.key);
  }

  // 저장소에만 있는 파일을 해시로 찾아, 내 폴더에만 있는 같은 내용과 짝짓는다(한 파일은 한 번만).
  const repoOnlyByHash = new Map<string, RepoFile[]>();
  for (const file of comparison.repoOnly) {
    repoOnlyByHash.set(file.blobHash, [...(repoOnlyByHash.get(file.blobHash) ?? []), file]);
  }
  const anyRepoByHash = new Map<string, RepoFile>();
  for (const file of allRepoFiles) if (!anyRepoByHash.has(file.blobHash)) anyRepoByHash.set(file.blobHash, file);

  for (const entry of comparison.localOnly) {
    const hash = localHashes.get(entry.relativePath);
    if (!hash) continue;
    const candidates = repoOnlyByHash.get(hash);
    if (candidates && candidates.length > 0) {
      findings.moved.push({ local: entry, repo: candidates.shift()! });
      continue;
    }
    const elsewhere = anyRepoByHash.get(hash);
    if (elsewhere) findings.alreadyInRepo.push({ local: entry, repo: elsewhere });
  }
  return findings;
}
