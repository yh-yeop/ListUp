import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

/**
 * 안드로이드 앱 안에서 업데이트 — 새 릴리즈의 APK 를 받아 시스템 설치 화면을 띄운다.
 *
 * - 처음 한 번은 안드로이드가 "이 출처의 앱 설치 허용"을 묻는다(REQUEST_INSTALL_PACKAGES, app.json).
 * - 설치 화면이 서명을 확인한다 — 같은 키로 서명된 APK 만 기존 앱 위에 덮어 설치된다(scripts/android-signing.mjs).
 *   그래서 받은 파일이 바뀌었더라도 다른 키의 앱으로 바뀌지는 않는다.
 */
export const apkInstallSupported = Platform.OS === 'android';

const UPDATE_DIR = `${LegacyFileSystem.cacheDirectory ?? ''}updates/`;
/** 시스템에 "이 파일을 읽어도 된다"고 넘긴다 (Intent.FLAG_GRANT_READ_URI_PERMISSION). */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/** APK 를 받아(onProgress 0~1) 설치 화면을 띄운다. 설치 화면을 닫으면 끝난다. */
export async function downloadAndInstallApk(
  asset: { name: string; url: string },
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (!apkInstallSupported) throw new Error('안드로이드 앱에서만 할 수 있습니다.');
  // 지난번에 받다 만 것이나 예전 버전은 지운다 — 한 번에 하나만.
  await LegacyFileSystem.deleteAsync(UPDATE_DIR, { idempotent: true });
  await LegacyFileSystem.makeDirectoryAsync(UPDATE_DIR, { intermediates: true });
  const target = `${UPDATE_DIR}${asset.name.replace(/[^\w.-]/g, '_')}`;

  const task = LegacyFileSystem.createDownloadResumable(asset.url, target, {}, (progress) => {
    const total = progress.totalBytesExpectedToWrite;
    onProgress?.(total > 0 ? Math.min(1, progress.totalBytesWritten / total) : 0);
  });
  const result = await task.downloadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error(`새 버전을 받지 못했습니다${result ? ` (HTTP ${result.status})` : ''}.`);
  }
  onProgress?.(1);

  // 앱 캐시의 파일을 설치 화면이 읽을 수 있게 content:// 로 넘긴다.
  const contentUri = await LegacyFileSystem.getContentUriAsync(result.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: 'application/vnd.android.package-archive',
  });
}
