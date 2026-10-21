import type { UploadSource } from '../../api/client';

/**
 * 올리기 전에 이미 올라가 있는 파일을 가르는 판정 — 플랫폼 import 가 없는 순수 함수(app/test 가 node 에서
 * 바로 불러 검사한다). 앱은 transfer.ts 가 다시 내보내는 것을 쓴다.
 */

export interface UploadItem {
  source: UploadSource;
  /** 저장소 안에서 둘 경로 */
  path: string;
}

/** 저장소에 지금 있는 파일 — 경로(NFC) → 크기·마지막으로 바뀐 때. */
export type RemoteFiles = Map<string, { size: number; updatedAt: number }>;

/** 저장소 목록(FileEntry)을 splitUnchanged 가 견줄 모양으로. */
export function remoteFilesOf(files: { path: string; size: number; updatedAt: number }[]): RemoteFiles {
  return new Map(files.map((file) => [file.path.normalize('NFC'), { size: file.size, updatedAt: file.updatedAt }]));
}

/**
 * 이미 올라가 있는 파일을 가른다 — 멈췄다가 같은 폴더를 다시 올릴 때 처음부터 다시 보내지 않게.
 * 같은 경로에 크기가 같고, 기기의 파일이 저장소에 올라간 때 뒤로 고쳐지지 않았으면 같은 파일로 본다.
 * 크기만 보면 태그만 고친 mp3 처럼 크기가 그대로인 수정을 놓치므로 고친 시각도 본다.
 * 고친 시각을 모르는 파일은 늘 올린다(서버가 내용이 같으면 반영하지 않는다).
 */
export function splitUnchanged(
  items: UploadItem[],
  remote: RemoteFiles,
): { changed: UploadItem[]; unchanged: UploadItem[] } {
  const changed: UploadItem[] = [];
  const unchanged: UploadItem[] = [];
  for (const item of items) {
    const existing = remote.get(item.path.normalize('NFC'));
    const modified = item.source.kind === 'desktop' ? undefined : item.source.lastModified;
    const same =
      existing !== undefined &&
      existing.size === item.source.size &&
      modified !== undefined &&
      modified > 0 &&
      modified <= existing.updatedAt;
    (same ? unchanged : changed).push(item);
  }
  return { changed, unchanged };
}
