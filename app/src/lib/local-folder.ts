import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import type { UploadSource } from '../api/client';
import { desktopBridge } from './desktop';
import { saveFolderLabel, saveIntoFolder } from './save-folder';

/**
 * 내 폴더 — "내 폴더와 비교"가 고른 기기의 폴더. 고를 때마다 새로 훑고, 저장해 두지 않는다.
 *
 *   PC 앱       PC 앱(main)이 폴더를 고르고 훑고 읽고 쓴다 — 받은 파일을 그 폴더에 바로 넣는다
 *   안드로이드   시스템 폴더 선택기(SAF) — 받은 파일을 그 폴더(하위 폴더까지)에 넣는다
 *   브라우저     폴더 선택 입력(webkitdirectory) — 목록과 올리기는 되지만 폴더에 쓸 수 없어, 받기는 브라우저 내려받기로
 *   iOS         폴더를 고를 수 없어 지원하지 않는다
 */

export interface LocalEntry {
  /** 고른 폴더 안의 경로 (`/` 로 나눔, 맨 위 폴더 이름은 빠짐). */
  relativePath: string;
  name: string;
  size: number;
  source: UploadSource;
}

export interface LocalFolder {
  /** 사람에게 보일 폴더 이름(PC 앱은 전체 경로). */
  label: string;
  entries: LocalEntry[];
  /** 파일이 너무 많아 다 훑지 못했다 — 없다고 나온 것 중 실제로는 있는 것이 섞일 수 있다. */
  truncated: boolean;
  /** 같은 폴더를 다시 훑는다. 브라우저는 다시 골라야 해서 null. */
  rescan: (() => Promise<LocalFolder>) | null;
  /** 받은 파일을 이 폴더 안 relativePath 에 둔다(하위 폴더를 만든다). 브라우저는 폴더에 쓸 수 없어 null. */
  save: ((relativePath: string, url: string, onProgress?: (fraction: number) => void) => Promise<void>) | null;
}

/** 훑는 최대 파일 수. */
const MAX_SCAN = 20_000;
/** 견주지 않는 OS 가 만든 파일. */
const JUNK = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.nomedia']);

export const localFolderSupported = Platform.OS === 'web' || Platform.OS === 'android';

const baseName = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf('/') + 1);

/** 폴더를 고르고 훑는다. 취소하면 null. */
export async function pickLocalFolder(): Promise<LocalFolder | null> {
  const folders = desktopBridge()?.folders;
  if (folders) {
    const picked = await folders.pick();
    return picked ? scanDesktop(picked.root) : null;
  }
  if (Platform.OS === 'web') return pickOnWeb();
  if (Platform.OS === 'android') {
    let root: Directory;
    try {
      root = await Directory.pickDirectoryAsync();
    } catch {
      return null; // 취소
    }
    return scanAndroid(root);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PC 앱
// ---------------------------------------------------------------------------
async function scanDesktop(root: string): Promise<LocalFolder> {
  const folders = desktopBridge()!.folders;
  const { entries, truncated } = await folders.scan(root);
  return {
    label: root,
    truncated,
    entries: entries.map((entry) => {
      const name = baseName(entry.relativePath);
      return {
        relativePath: entry.relativePath,
        name,
        size: entry.size,
        source: { kind: 'desktop', root, relativePath: entry.relativePath, name, size: entry.size },
      };
    }),
    rescan: () => scanDesktop(root),
    save: async (relativePath, url) => {
      await folders.save(root, relativePath, url);
    },
  };
}

// ---------------------------------------------------------------------------
// 안드로이드
// ---------------------------------------------------------------------------
function scanAndroid(root: Directory): LocalFolder {
  const entries: LocalEntry[] = [];
  let truncated = false;
  const walk = (dir: Directory, prefix: string) => {
    let items: (Directory | File)[];
    try {
      items = dir.list();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_SCAN) {
        truncated = true;
        return;
      }
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item instanceof Directory) {
        walk(item, relativePath);
      } else if (!JUNK.has(item.name.toLowerCase())) {
        const size = item.info().size ?? 0;
        entries.push({
          relativePath,
          name: item.name,
          size,
          source: {
            kind: 'native',
            uri: item.uri,
            name: item.name,
            size,
            mimeType: 'application/octet-stream',
            relativePath,
          },
        });
      }
    }
  };
  walk(root, '');
  return {
    label: saveFolderLabel(root),
    entries,
    truncated,
    rescan: async () => scanAndroid(root),
    save: (relativePath, url, onProgress) => saveIntoAndroidFolder(root, relativePath, url, onProgress),
  };
}

/** 하위 폴더를 찾거나 만든다. */
function childDirectory(parent: Directory, name: string): Directory {
  for (const item of parent.list()) {
    if (item instanceof Directory && item.name === name) return item;
  }
  return parent.createDirectory(name);
}

async function saveIntoAndroidFolder(
  root: Directory,
  relativePath: string,
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const segments = relativePath.split('/');
  const name = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = childDirectory(dir, segment);

  // 캐시에 받은 뒤(끊기면 이어서) 폴더로 옮긴다 — SAF 폴더에는 받는 작업이 바로 쓰지 못한다.
  const cacheDir = new Directory(Paths.cache, 'listup-compare');
  if (!cacheDir.exists) cacheDir.create({ intermediates: true });
  const cached = new File(cacheDir, name);
  if (cached.exists) cached.delete();
  const task = LegacyFileSystem.createDownloadResumable(url, cached.uri, {}, (progress) => {
    const total = progress.totalBytesExpectedToWrite;
    if (total > 0) onProgress?.(progress.totalBytesWritten / total);
  });
  let result: LegacyFileSystem.FileSystemDownloadResult | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = attempt === 0 ? await task.downloadAsync() : await task.resumeAsync();
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  if (!result || result.status >= 400) throw new Error('파일을 받지 못했습니다.');
  await saveIntoFolder(new File(result.uri), dir);
}

// ---------------------------------------------------------------------------
// 브라우저
// ---------------------------------------------------------------------------
function pickOnWeb(): Promise<LocalFolder | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    const finish = (folder: LocalFolder | null) => {
      input.remove();
      resolve(folder);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      let label = '고른 폴더';
      const entries: LocalEntry[] = [];
      for (const file of files) {
        // webkitRelativePath 는 맨 위 폴더 이름부터 — 폴더 안의 경로로 바꾼다.
        const full = (file as { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const slash = full.indexOf('/');
        if (slash > 0) label = full.slice(0, slash);
        const relativePath = slash > 0 ? full.slice(slash + 1) : full;
        if (JUNK.has(file.name.toLowerCase())) continue;
        entries.push({
          relativePath,
          name: file.name,
          size: file.size,
          source: { kind: 'web', file, name: file.name, size: file.size, relativePath },
        });
      }
      finish({
        label,
        entries: entries.slice(0, MAX_SCAN),
        truncated: entries.length > MAX_SCAN,
        rescan: null,
        save: null,
      });
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
