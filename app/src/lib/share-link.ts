import { Platform } from 'react-native';
import { isOwnHostUrl, shareableHostUrl, useHostStatus } from './desktop';
import { useAuth } from '../state/auth';
import { serverUrl } from '../state/servers';

/**
 * 남에게 건넬 링크의 서버 주소 — 지금 이 서버에 들어온 주소. PC 앱에서 자기 PC 서버(localhost)에 들어와 있으면
 * 받는 사람에게 localhost 는 그 사람 기기라 공개 주소(없으면 공유기 안 주소)로 만든다. 초대 링크·공개 링크가 함께 쓴다.
 */
export function useLinkBase(): string {
  const { activeServer } = useAuth();
  const hostStatus = useHostStatus();
  const activeUrl = activeServer ? serverUrl(activeServer) : '';
  const base =
    hostStatus && activeUrl && isOwnHostUrl(activeUrl, hostStatus) ? (shareableHostUrl(hostStatus) ?? activeUrl) : activeUrl;
  // 같은 오리진으로 빌드한 웹(서버 주소가 '')이면 지금 보고 있는 주소가 곧 서버다.
  return (base || (Platform.OS === 'web' ? window.location.origin : '')).replace(/\/+$/, '');
}

/** 공개 링크 — 브라우저로 여는 서버의 페이지. */
export function shareLinkFor(base: string, token: string): string {
  return `${base}/s/${token}`;
}
