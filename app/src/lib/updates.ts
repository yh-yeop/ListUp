import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Linking } from 'react-native';
import { IS_CLIENT_BUILD } from '../api/client';
import { confirmAction } from './dialogs';

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

const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
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
    return {
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
      latest:
        latest && typeof latest.version === 'string' && typeof latest.url === 'string' ? latest : null,
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
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown } | null;
    if (typeof body?.tag_name !== 'string') return null;
    return {
      version: body.tag_name.replace(/^v/i, ''),
      url: typeof body.html_url === 'string' ? body.html_url : LATEST_RELEASE_URL,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 최신 릴리즈가 이 앱보다 새 버전이면 그 릴리즈를, 아니면 null.
 * 최근에 확인했으면 GitHub 에 다시 묻지 않고 기억해 둔 결과를 쓴다. 닿지 못하면 조용히 null.
 */
export async function checkForUpdate(): Promise<LatestRelease | null> {
  if (!updateChecksEnabled()) return null;
  const cache = await readCache();
  let latest = cache.latest;
  if (Date.now() - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const fetched = await fetchLatestRelease();
    if (fetched) {
      latest = fetched;
      await writeCache({ ...cache, checkedAt: Date.now(), latest });
    }
  }
  return latest && compareVersions(latest.version, APP_VERSION) > 0 ? latest : null;
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

/**
 * 앱을 열 때 한 번 — 새 버전이 있고 그 버전을 아직 제안한 적이 없으면 받으러 갈지 묻는다.
 * 같은 버전은 다시 묻지 않는다(설정 화면에서는 계속 받을 수 있다).
 */
export async function suggestUpdateOnce(): Promise<void> {
  if (promptedThisSession || !updateChecksEnabled()) return;
  promptedThisSession = true;
  const latest = await checkForUpdate();
  if (!latest) return;
  const cache = await readCache();
  if (cache.promptedVersion === latest.version) return;
  // 묻기 전에 기록한다 — 대화상자를 닫거나 앱이 꺼져도 같은 버전을 계속 묻지 않게.
  await writeCache({ ...cache, promptedVersion: latest.version });
  const ok = await confirmAction({
    title: '새 버전이 있습니다',
    message: `ListUp v${latest.version} 이 나왔습니다 (지금 v${APP_VERSION}).\n릴리즈 페이지에서 받아 설치할까요?`,
    confirmLabel: '받으러 가기',
  });
  if (ok) await openReleasePage(latest.url);
}
