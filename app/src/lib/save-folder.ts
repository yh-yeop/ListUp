import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';
import { confirmAction } from './dialogs';

/**
 * 안드로이드에서 받은 파일을 둘 폴더 — 처음 받을 때 한 번 고르고 기억한다.
 *
 * 앱은 휴대폰의 공용 폴더(다운로드 등)에 마음대로 쓸 수 없어서, 사용자가 시스템 폴더 선택기로 고른
 * 폴더(SAF)에 쓴다. 선택기가 준 권한은 앱을 다시 켜도 남는다. 안드로이드 11 부터는 "Download" 폴더
 * 자체는 고를 수 없어서, 그 안에 폴더를 하나 만들어 고르게 안내한다.
 *
 * iOS 에는 이런 폴더가 없어 공유 시트("파일에 저장")를 쓴다.
 */

const KEY = 'listup.downloadDir';
/** 선택기가 처음 열 곳 — 내장 저장소의 Download. */
const DOWNLOAD_HINT = 'content://com.android.externalstorage.documents/document/primary%3ADownload';

export const saveFolderSupported = Platform.OS === 'android';

/** 기억해 둔 저장 폴더. 없거나 권한이 사라졌으면 null. */
export async function getSaveFolder(): Promise<Directory | null> {
  if (!saveFolderSupported) return null;
  const uri = await AsyncStorage.getItem(KEY).catch(() => null);
  if (!uri) return null;
  try {
    const dir = new Directory(uri);
    if (dir.exists) return dir;
  } catch {
    // 폴더가 지워졌거나 권한이 회수됐다.
  }
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
  return null;
}

/** 기억해 둔 폴더를 잊는다 — 쓰기에 실패했을 때(권한 회수 등) 다음에 다시 고르게. */
export async function forgetSaveFolder(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
}

/** 저장 폴더를 새로 고른다. 안내를 먼저 보여 준다. 취소하면 null. */
export async function chooseSaveFolder(): Promise<Directory | null> {
  const ok = await confirmAction({
    title: '받은 파일을 둘 폴더를 골라 주세요',
    message:
      '한 번 고르면 다음부터는 바로 그 폴더에 저장합니다.\n\n' +
      '"Download" 폴더 자체는 안드로이드가 고르지 못하게 막으니, 그 안에서 폴더 만들기로 "ListUp" 같은 폴더를 만들어 고르세요. ' +
      '설정에서 언제든 바꿀 수 있습니다.',
    confirmLabel: '폴더 고르기',
  });
  if (!ok) return null;
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync(DOWNLOAD_HINT);
  } catch {
    return null; // 취소
  }
  await AsyncStorage.setItem(KEY, dir.uri).catch(() => undefined);
  return dir;
}

/** 기억해 둔 폴더를 쓰고, 없으면 고르게 한다. */
export async function ensureSaveFolder(): Promise<Directory | null> {
  return (await getSaveFolder()) ?? (await chooseSaveFolder());
}

/** 사람에게 보여 줄 폴더 이름. */
export function saveFolderLabel(dir: Directory): string {
  try {
    return dir.name || '고른 폴더';
  } catch {
    return '고른 폴더';
  }
}

/**
 * 캐시에 받아 둔 파일을 저장 폴더로 옮긴다(스트림 복사 — 큰 파일도 메모리에 올리지 않는다).
 * 같은 이름이 있으면 덮어쓰지 않고 "이름 (1).확장자" 로. 돌려주는 값은 저장한 이름.
 */
export async function saveIntoFolder(cached: File, dir: Directory): Promise<string> {
  const taken = new Set<string>();
  try {
    for (const entry of dir.list()) taken.add(entry.name);
  } catch {
    // 목록을 못 읽어도 저장은 시도한다 — 이름이 겹치면 아래 copy 가 실패한다.
  }
  const name = uniqueName(cached.name, taken);
  if (name !== cached.name) cached.rename(name);
  try {
    await cached.copy(dir);
  } finally {
    try {
      cached.delete();
    } catch {
      // 캐시는 OS 가 치운다.
    }
  }
  return name;
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
