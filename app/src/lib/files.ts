import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { authHeaders } from '../api/client';
import type { UploadSource } from '../api/client';

/**
 * 파일 선택. 웹에서는 File 객체를, 네이티브에서는 uri 를 돌려준다.
 * 두 경우 모두 그대로 api.uploadFile / api.uploadBlob 에 넘길 수 있다.
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

/** 다운로드 결과 — 사용자에게 보여줄 안내 문구를 함께 돌려준다. */
export interface DownloadResult {
  ok: boolean;
  message: string;
}

/**
 * 파일 저장. 토큰이 필요하므로 링크를 그냥 열 수 없고, 직접 받아서 넘겨준다.
 * - 웹: Blob 을 만들어 브라우저 다운로드를 띄운다.
 * - 네이티브: 캐시에 받은 뒤 공유 시트를 띄운다 (사진/파일 앱 등으로 저장).
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

  const downloads = new Directory(Paths.cache, 'listup-downloads');
  if (!downloads.exists) downloads.create({ intermediates: true });

  // 같은 이름의 이전 파일이 남아 있으면 덮어쓴다.
  const target = new File(downloads, fileName);
  const saved = await File.downloadFileAsync(url, target, {
    headers: authHeaders(),
    idempotent: true,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(saved.uri);
    return { ok: true, message: '' };
  }
  return { ok: true, message: `${saved.uri} 에 저장했습니다.` };
}
