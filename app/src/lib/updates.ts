import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';
import { IS_CLIENT_BUILD } from '../api/client';
import type { DesktopUpdates, DesktopUpdateState } from '@listup/shared';
import { apkInstallSupported, downloadAndInstallApk } from './apk-update';
import { desktopBridge } from './desktop';
import { confirmAction, notify, notifyError } from './dialogs';

/**
 * 설치형 클라이언트의 업데이트 확인. 새 버전(APK 등)은 GitHub 릴리즈에 올린다.
 *
 * 앱을 열 때 최신 릴리즈와 이 앱의 버전을 견줘 새 버전이면 한 번 제안하고, 서버에 들어가려는데
 * 앱이 오래돼 들어갈 수 없으면(API 버전이 다름) 릴리즈 페이지를 바로 연다.
 *
 * 서버가 주는 웹은 확인하지 않는다 — 서버가 늘 자기 버전에 맞는 웹을 준다.
 */

const extra = Constants.expoConfig?.extra as { updateRepo?: string } | undefined;
/** 릴리즈를 올리는 GitHub 저장소. 포크했다면 app.json 의 extra.updateRepo 를 바꾼다. */
const REPO = extra?.updateRepo ?? 'yh-yeop/ListUp';

/** 소스 저장소. AGPL-3.0 §13 — 네트워크로 쓰는 사람에게 소스를 받을 길을 알린다. */
export const SOURCE_URL = `https://github.com/${REPO}`;
/** 가장 최근 릴리즈 페이지. API 에 닿지 못해도 이 주소는 늘 최신으로 간다. */
export const LATEST_RELEASE_URL = `${SOURCE_URL}/releases/latest`;
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

/**
 * 최신 릴리즈를 묻는 주소. EXPO_PUBLIC_LISTUP_UPDATE_API 는 시험 빌드용 — 에뮬레이터 흐름 테스트가 가짜 릴리즈를
 * 내주는 로컬 서버를 가리킨다(e2e/android.mjs). 정식 빌드에는 넣지 않는다.
 */
const LATEST_API = process.env.EXPO_PUBLIC_LISTUP_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = 'listup.update';
/**
 * 최신 릴리즈를 다시 묻는 간격. 로그인 없는 GitHub API 는 IP 당 시간에 60번까지라,
 * 앱을 열 때마다 묻지 않는다.
 */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface LatestRelease {
  version: string;
  url: string;
  /** 이 기기에 맞는 설치 파일(안드로이드 APK·PC 설치 파일). 릴리즈에 없거나 웹이면 null. */
  asset?: { name: string; url: string } | null;
}

/**
 * 확인 결과.
 * - update: 새 버전이 있다
 * - current: 최신이다
 * - unknown: GitHub 에 닿지 못했고 기억해 둔 결과도 없다(또는 지금 확인하라고 했는데 닿지 못했다)
 */
export type UpdateStatus =
  | { status: 'update'; latest: LatestRelease }
  | { status: 'current'; latest: LatestRelease }
  | { status: 'unknown' };

/** 이 앱이 무엇인지 — 버전 옆에 보여 준다. */
export function clientKind(): string {
  if (desktopBridge()) return 'PC 앱';
  if (Platform.OS === 'android') return '안드로이드 앱';
  if (Platform.OS === 'ios') return 'iOS 앱';
  return IS_CLIENT_BUILD ? '웹 클라이언트' : '웹';
}

/** 릴리즈 파일 중 이 기기에 맞는 것의 이름 모양. 릴리즈 스크립트가 붙이는 이름이다(scripts/publish-release.mjs). */
function assetPattern(): RegExp | null {
  if (desktopBridge()) return /-windows-setup\.exe$/i;
  if (Platform.OS === 'android') return /-android\.apk$/i;
  return null;
}

interface UpdateCache {
  checkedAt: number;
  latest: LatestRelease | null;
  /** 이미 업데이트를 제안한 버전. 같은 버전은 다시 묻지 않는다. */
  promptedVersion: string | null;
}

/** 업데이트를 확인하는 빌드인지 — 설치형 클라이언트만. */
export function updateChecksEnabled(): boolean {
  return IS_CLIENT_BUILD;
}

/** `1.10.0` 과 `1.9.2` 처럼 숫자로 견준다. 앞의 `v` 와 `-beta` 같은 꼬리는 무시한다. a>b 면 양수. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readCache(): Promise<UpdateCache> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<UpdateCache>) : {};
    const latest = parsed.latest;
    const asset = latest?.asset;
    return {
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
      latest:
        latest && typeof latest.version === 'string' && typeof latest.url === 'string'
          ? {
              version: latest.version,
              url: latest.url,
              asset: asset && typeof asset.name === 'string' && typeof asset.url === 'string' ? asset : null,
            }
          : null,
      promptedVersion: typeof parsed.promptedVersion === 'string' ? parsed.promptedVersion : null,
    };
  } catch {
    return { checkedAt: 0, latest: null, promptedVersion: null };
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 못 쓰면 다음에 다시 물을 뿐이다.
  }
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
      assets?: { name?: unknown; browser_download_url?: unknown }[];
    } | null;
    if (typeof body?.tag_name !== 'string') return null;
    const pattern = assetPattern();
    const match = pattern && Array.isArray(body.assets)
      ? body.assets.find((a) => typeof a?.name === 'string' && pattern.test(a.name))
      : undefined;
    return {
      version: body.tag_name.replace(/^v/i, ''),
      url: typeof body.html_url === 'string' ? body.html_url : LATEST_RELEASE_URL,
      asset:
        match && typeof match.name === 'string' && typeof match.browser_download_url === 'string'
          ? { name: match.name, url: match.browser_download_url }
          : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 지금 GitHub 에 묻는 중인 요청 — 앱을 열 때의 확인과 화면의 버전 표시가 따로 묻지 않게 함께 쓴다. */
let inflight: Promise<LatestRelease | null> | null = null;

async function refreshLatest(): Promise<LatestRelease | null> {
  if (!inflight) {
    inflight = (async () => {
      const fetched = await fetchLatestRelease();
      if (fetched) await writeCache({ ...(await readCache()), checkedAt: Date.now(), latest: fetched });
      return fetched;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * 최신 릴리즈와 견준다. 최근(CHECK_INTERVAL_MS 안)에 확인했으면 GitHub 에 다시 묻지 않고 기억해 둔 결과를 쓴다.
 * force 면 늘 묻는다 — 사용자가 "업데이트 확인"을 눌렀을 때. 그때 닿지 못하면 unknown(오래된 결과로 최신이라고 하지 않는다).
 */
export async function checkUpdate({ force = false }: { force?: boolean } = {}): Promise<UpdateStatus> {
  if (!updateChecksEnabled()) return { status: 'unknown' };
  const cache = await readCache();
  let latest = cache.latest;
  if (force || Date.now() - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const fetched = await refreshLatest();
    if (fetched) latest = fetched;
    else if (force) return { status: 'unknown' };
  }
  if (!latest) return { status: 'unknown' };
  return compareVersions(latest.version, APP_VERSION) > 0 ? { status: 'update', latest } : { status: 'current', latest };
}

/** 최신 릴리즈가 이 앱보다 새 버전이면 그 릴리즈를, 아니면 null. 닿지 못하면 조용히 null. */
export async function checkForUpdate(): Promise<LatestRelease | null> {
  const result = await checkUpdate();
  return result.status === 'update' ? result.latest : null;
}

/** 릴리즈 페이지를 연다 (브라우저). */
export async function openReleasePage(url: string = LATEST_RELEASE_URL): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    // 열 수 있는 앱이 없으면 할 수 있는 게 없다.
  }
}

let promptedThisSession = false;

/** 이 버전을 이미 제안했는지 적어 둔다. 처음이면 true — 그때만 묻는다. */
async function markPrompted(version: string): Promise<boolean> {
  const cache = await readCache();
  if (cache.promptedVersion === version) return false;
  // 묻기 전에 기록한다 — 대화상자를 닫거나 앱이 꺼져도 같은 버전을 계속 묻지 않게.
  await writeCache({ ...cache, promptedVersion: version });
  return true;
}

/** 자동 업데이트가 도는 PC 앱인지(1.7 부터, 설치본). */
async function activeDesktopUpdates(): Promise<DesktopUpdates | null> {
  const updates = desktopBridge()?.updates;
  if (!updates) return null;
  return (await updates.getState()).status === 'disabled' ? null : updates;
}

/** PC 앱 — 새 버전을 받아 두면 한 번, 다시 시작해 설치할지 묻는다. */
function watchDesktopUpdate(updates: DesktopUpdates): void {
  let asking = false;
  const handle = async (state: DesktopUpdateState) => {
    if (state.status !== 'ready' || !state.version || asking) return;
    asking = true;
    try {
      if (!(await markPrompted(state.version))) return;
      const ok = await confirmAction({
        title: '새 버전을 받아 두었습니다',
        message:
          `ListUp v${state.version} (지금 v${APP_VERSION}). 지금 다시 시작해 설치할까요?
` +
          '나중에 해도 ListUp 을 끝낼 때 설치됩니다. 켜 둔 서버는 설치 뒤 다시 켜집니다.',
        confirmLabel: '다시 시작해 설치',
      });
      if (ok) await updates.install();
    } finally {
      asking = false;
    }
  };
  updates.subscribe((state) => void handle(state));
  void updates.getState().then(handle);
}

/** 안드로이드 — APK 를 받아 설치 화면을 띄운다. 받는 동안은 토스트로 알린다. */
export async function installApkUpdate(latest: LatestRelease, onProgress?: (fraction: number) => void): Promise<boolean> {
  if (!latest.asset) return false;
  try {
    await downloadAndInstallApk(latest.asset, onProgress);
    return true;
  } catch (err) {
    notifyError('새 버전을 설치하지 못했습니다.', err instanceof Error ? err.message : undefined);
    return false;
  }
}

/**
 * 앱을 열 때 한 번 — 새 버전이 있고 그 버전을 아직 제안한 적이 없으면 묻는다.
 * - PC 앱(자동 업데이트): 백그라운드로 받아 두면 다시 시작해 설치할지
 * - 안드로이드: 받아서 설치할지 → 설치 화면
 * - 그 밖: 릴리즈 페이지로 받으러 갈지
 * 같은 버전은 다시 묻지 않는다(서버 목록·내 정보에서는 계속 받을 수 있다).
 */
export async function suggestUpdateOnce(): Promise<void> {
  if (promptedThisSession || !updateChecksEnabled()) return;
  promptedThisSession = true;
  const desktopUpdates = await activeDesktopUpdates();
  if (desktopUpdates) {
    watchDesktopUpdate(desktopUpdates);
    return;
  }
  const latest = await checkForUpdate();
  if (!latest) return;
  if (!(await markPrompted(latest.version))) return;
  if (apkInstallSupported && latest.asset) {
    const install = await confirmAction({
      title: '새 버전이 있습니다',
      message: `ListUp v${latest.version} 이 나왔습니다 (지금 v${APP_VERSION}).
받아서 설치할까요? (${latest.asset.name})`,
      confirmLabel: '받아서 설치',
    });
    if (!install) return;
    notify(`v${latest.version} 을 받는 중입니다…`, '다 받으면 설치 화면이 뜹니다.');
    await installApkUpdate(latest);
    return;
  }
  const ok = await confirmAction({
    title: '새 버전이 있습니다',
    message:
      `ListUp v${latest.version} 이 나왔습니다 (지금 v${APP_VERSION}).\n` +
      (latest.asset ? `릴리즈 페이지에서 ${latest.asset.name} 을(를) 받아 설치하세요.` : '릴리즈 페이지에서 받아 설치할까요?'),
    confirmLabel: '받으러 가기',
  });
  if (ok) await openReleasePage(latest.url);
}
