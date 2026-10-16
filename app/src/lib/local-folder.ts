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
  /** 마지막으로 고친 시각(ms) — 알면 해시를 다시 계산하지 않아도 되는지 정하는 데 쓴다. */
  mtime?: number;
  source: UploadSource;
}

/** 다시 열 수 있는 폴더 — 동기화가 기억해 둔다. 브라우저는 다시 열 수 없다. */
export type FolderRef = { kind: 'desktop'; root: string } | { kind: 'android'; uri: string };

export interface SaveOptions {
  /** 같은 이름이 있으면 바꾼다(동기화의 받기). 아니면 "이름 (1)" 로 둔다. */
  overwrite?: boolean;
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
  save:
    | ((relativePath: string, url: string, onProgress?: (fraction: number) => void, options?: SaveOptions) => Promise<void>)
    | null;
  /** 폴더 안 파일을 지운다(PC 앱은 휴지통으로). 지울 수 없으면 null. */
  remove: ((relativePath: string) => Promise<void>) | null;
  /** 다시 열 때 쓰는 참조. 브라우저는 null. */
  ref: FolderRef | null;
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
        mtime: entry.mtime,
        source: { kind: 'desktop', root, relativePath: entry.relativePath, name, size: entry.size },
      };
    }),
    rescan: () => scanDesktop(root),
    save: async (relativePath, url, _onProgress, options) => {
      await folders.save(root, relativePath, url, options);
    },
    remove: folders.trash ? (relativePath) => folders.trash!(root, relativePath) : null,
    ref: { kind: 'desktop', root },
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
        const info = item.info();
        const size = info.size ?? 0;
        entries.push({
          relativePath,
          name: item.name,
          size,
          mtime: typeof info.modificationTime === 'number' ? info.modificationTime : undefined,
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
    save: (relativePath, url, onProgress, options) => saveIntoAndroidFolder(root, relativePath, url, onProgress, options),
    remove: async (relativePath) => {
      const file = findAndroidFile(root, relativePath);
      if (file) file.delete();
    },
    ref: { kind: 'android', uri: root.uri },
  };
}

/** 폴더 안 경로의 파일. 없으면 null. */
function findAndroidFile(root: Directory, relativePath: string): File | null {
  const segments = relativePath.split('/');
  const name = segments.pop()!;
  let dir: Directory = root;
  for (const segment of segments) {
    const next = dir.list().find((item): item is Directory => item instanceof Directory && item.name === segment);
    if (!next) return null;
    dir = next;
  }
  return dir.list().find((item): item is File => !(item instanceof Directory) && item.name === name) ?? null;
}

/**
 * 기억해 둔 폴더를 다시 연다(동기화). PC 앱은 기억해 둔 폴더만 main 이 다시 허락한다. 안드로이드는 고를 때 받은
 * 권한이 남아 있어야 한다 — 열지 못하면 던지고, 화면이 다시 고르게 한다.
 */
export async function openFolderRef(ref: FolderRef): Promise<LocalFolder> {
  if (ref.kind === 'desktop') {
    if (!desktopBridge()?.folders) throw new Error('PC 앱에서만 열 수 있는 폴더입니다.');
    return scanDesktop(ref.root);
  }
  if (Platform.OS !== 'android') throw new Error('안드로이드 앱에서만 열 수 있는 폴더입니다.');
  const root = new Directory(ref.uri);
  if (!root.exists) throw new Error('폴더를 열 수 없습니다. 폴더를 다시 골라 주세요.');
  return scanAndroid(root);
}

/** 동기화할 폴더로 기억한다 — PC 앱은 main 에게 알려 앱을 다시 켜도 열 수 있게 한다. */
export async function rememberFolder(folder: LocalFolder): Promise<boolean> {
  if (folder.ref?.kind === 'desktop') return (await desktopBridge()?.folders.remember?.(folder.ref.root)) ?? false;
  return folder.ref !== null;
}

export async function forgetFolder(ref: FolderRef): Promise<void> {
  if (ref.kind === 'desktop') await desktopBridge()?.folders.forget?.(ref.root);
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
  options: SaveOptions = {},
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
  if (options.overwrite) {
    // 동기화는 같은 이름의 옛 파일을 바꾼다 — 다 받은 뒤에 옛것을 지워, 받다 끊겨도 옛 파일은 남는다.
    const existing = dir.list().find((item): item is File => !(item instanceof Directory) && item.name === name);
    existing?.delete();
  }
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
          mtime: file.lastModified,
          source: { kind: 'web', file, name: file.name, size: file.size, relativePath },
        });
      }
      finish({
        label,
        entries: entries.slice(0, MAX_SCAN),
        truncated: entries.length > MAX_SCAN,
        rescan: null,
        save: null,
        remove: null,
        ref: null,
      });
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
