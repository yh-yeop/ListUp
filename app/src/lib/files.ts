import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { MAX_FILES_PER_REPO } from '@listup/shared';
import { Platform } from 'react-native';
import { api, authHeaders, resolveApiUrl } from '../api/client';
import type { UploadSource } from '../api/client';
import { ensureSaveFolder, forgetSaveFolder, saveFolderLabel, saveFolderSupported, saveIntoFolder } from './save-folder';

/**
 * 파일 선택. 웹에서는 File 객체를, 네이티브에서는 uri 를 돌려준다.
 * 두 경우 모두 그대로 lib/transfer.ts 의 올리기에 넘길 수 있다.
 */
export async function pickFiles(multiple = true): Promise<UploadSource[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple,
    copyToCacheDirectory: true,
    // base64 를 만들면 큰 파일에서 메모리를 크게 쓴다. 웹에서는 File 객체로 충분하다.
    base64: false,
  });
  if (result.canceled) return [];

  return result.assets.map((asset) => {
    if (Platform.OS === 'web' && asset.file) {
      return {
        kind: 'web' as const,
        file: asset.file,
        name: asset.name,
        size: asset.size ?? asset.file.size,
      };
    }
    return {
      kind: 'native' as const,
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? 0,
      mimeType: asset.mimeType ?? 'application/octet-stream',
    };
  });
}

/**
 * 폴더를 통째로 고른다 — 폴더 안의 파일을 relativePath(맨 위 폴더 이름부터)와 함께 돌려준다.
 * 저장소 파일 수 한도보다 많으면 거기서 멈춘다(서버가 어차피 거절한다).
 * - 웹: 폴더 선택 입력(webkitdirectory)
 * - 안드로이드: 시스템 폴더 선택기. iOS 는 지원하지 않는다.
 */
export async function pickFolder(): Promise<UploadSource[]> {
  if (Platform.OS === 'web') return pickFolderOnWeb();
  if (Platform.OS !== 'android') return [];
  let root: Directory;
  try {
    root = await Directory.pickDirectoryAsync();
  } catch {
    return []; // 취소
  }
  const sources: UploadSource[] = [];
  const walk = (dir: Directory, prefix: string) => {
    for (const entry of dir.list()) {
      if (sources.length >= MAX_FILES_PER_REPO) return;
      if (entry instanceof Directory) {
        walk(entry, `${prefix}/${entry.name}`);
      } else {
        sources.push({
          kind: 'native',
          uri: entry.uri,
          name: entry.name,
          size: entry.info().size ?? 0,
          mimeType: 'application/octet-stream',
          relativePath: `${prefix}/${entry.name}`,
        });
      }
    }
  };
  walk(root, root.name);
  return sources;
}

function pickFolderOnWeb(): Promise<UploadSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // 폴더를 고르게 한다 — 각 File 에 폴더 안 경로(webkitRelativePath)가 붙는다.
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    const finish = (sources: UploadSource[]) => {
      input.remove();
      resolve(sources);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []).slice(0, MAX_FILES_PER_REPO);
      finish(
        files.map((file) => ({
          kind: 'web' as const,
          file,
          name: file.name,
          size: file.size,
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        })),
      );
    });
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** 다운로드 결과 — 사용자에게 보여줄 안내 문구를 함께 돌려준다. */
export interface DownloadResult {
  ok: boolean;
  message: string;
}

/**
 * 저장소의 파일이나 폴더(zip)를 받는다. 짧게 사는 다운로드 링크(서버 routes/downloads.ts)를 받아서 —
 * - 웹: 브라우저에 넘긴다. 브라우저가 디스크로 바로 받고 진행률을 보여 주며, 끊기면 이어받는다.
 * - 네이티브: 진행률이 나오는 다운로드 작업으로 캐시에 받고(끊기면 이어서 몇 번 더) 내보낸다
 *   ({@link deliver} — 안드로이드는 고른 저장 폴더로, iOS 는 공유 시트).
 */
export async function downloadFromRepo(
  repoId: string,
  target: { path: string; snapshotId?: string; archive?: boolean; fileName: string },
  onProgress?: (fraction: number) => void,
): Promise<DownloadResult> {
  const link = await api.downloadLink(repoId, {
    path: target.path,
    snapshot: target.snapshotId,
    archive: target.archive,
  });
  const url = resolveApiUrl(link.url);

  if (Platform.OS === 'web') {
    // 링크는 attachment 로 내려오므로 이동해도 페이지가 바뀌지 않고 다운로드만 시작된다.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { ok: true, message: '' };
  }

  // 받기 전에 저장 폴더부터 — 다 받은 뒤에 고르다 취소하면 받은 것이 헛수고다.
  const folder = saveFolderSupported ? await ensureSaveFolder() : null;
  if (saveFolderSupported && !folder) return { ok: false, message: '' };

  const downloads = new Directory(Paths.cache, 'listup-downloads');
  if (!downloads.exists) downloads.create({ intermediates: true });
  const target_ = new File(downloads, target.fileName);
  if (target_.exists) target_.delete();

  const task = LegacyFileSystem.createDownloadResumable(url, target_.uri, {}, (progress) => {
    const total = progress.totalBytesExpectedToWrite;
    if (total > 0) onProgress?.(progress.totalBytesWritten / total);
  });
  let result: LegacyFileSystem.FileSystemDownloadResult | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = attempt === 0 ? await task.downloadAsync() : await task.resumeAsync();
      break;
    } catch (err) {
      // 끊기면 받은 데서부터 이어 받는다 (서버가 Range 를 지원한다).
      if (attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  if (!result || result.status >= 400) return { ok: false, message: '파일을 받지 못했습니다.' };
  return deliver(new File(result.uri), folder);
}

/**
 * 캐시에 받은 파일을 사용자에게 내보낸다.
 * - 안드로이드: 고른 저장 폴더에 넣는다(설정에서 바꿈). 공유 시트는 "받기"가 아니라 "보내기"라 쓰지 않는다.
 * - iOS: 공유 시트("파일에 저장").
 */
async function deliver(cached: File, folder: Directory | null): Promise<DownloadResult> {
  if (folder) {
    try {
      const name = await saveIntoFolder(cached, folder);
      return { ok: true, message: `${saveFolderLabel(folder)} 폴더에 ${name} 을(를) 저장했습니다.` };
    } catch {
      await forgetSaveFolder();
      return { ok: false, message: '저장 폴더에 쓰지 못했습니다. 다시 받으면 폴더를 새로 고릅니다.' };
    }
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(cached.uri);
    return { ok: true, message: '' };
  }
  return { ok: true, message: `${cached.uri} 에 저장했습니다.` };
}

/**
 * 로그인 헤더를 붙여 받는다 — 다운로드 링크가 없는 곳(제안에 담긴 파일)에 쓴다.
 * - 웹: Blob 을 만들어 브라우저 다운로드를 띄운다.
 * - 네이티브: 캐시에 받은 뒤 내보낸다 (안드로이드는 저장 폴더, iOS 는 공유 시트).
 */
export async function downloadFile(url: string, fileName: string): Promise<DownloadResult> {
  if (Platform.OS === 'web') {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) return { ok: false, message: '파일을 받지 못했습니다.' };

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 브라우저가 다운로드를 시작할 시간을 준 뒤 해제한다.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true, message: `${fileName} 을(를) 내려받았습니다.` };
  }

  const folder = saveFolderSupported ? await ensureSaveFolder() : null;
  if (saveFolderSupported && !folder) return { ok: false, message: '' };

  const downloads = new Directory(Paths.cache, 'listup-downloads');
  if (!downloads.exists) downloads.create({ intermediates: true });

  // 같은 이름의 이전 파일이 남아 있으면 덮어쓴다.
  const target = new File(downloads, fileName);
  const saved = await File.downloadFileAsync(url, target, {
    headers: authHeaders(),
    idempotent: true,
  });
  return deliver(saved, folder);
}
