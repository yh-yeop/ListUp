import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { DesktopBridge, HostStatus } from '@listup/shared';

/**
 * PC 앱(Electron)이 창에 넣어 주는 `window.listupDesktop`. 브라우저·폰에서는 null.
 * 계약은 shared 의 DesktopBridge, 구현은 desktop/src/preload.ts.
 */
export function desktopBridge(): DesktopBridge | null {
  if (Platform.OS !== 'web') return null;
  return (globalThis as { listupDesktop?: DesktopBridge }).listupDesktop ?? null;
}

/** 이 PC 에서 서버를 열 수 있는지 — PC 앱일 때만. */
export function hostSupported(): boolean {
  return desktopBridge()?.host != null;
}

/** 이 PC 서버의 상태. 바뀔 때마다 다시 그린다. PC 앱이 아니면 늘 null. */
export function useHostStatus(): HostStatus | null {
  const [status, setStatus] = useState<HostStatus | null>(null);
  useEffect(() => {
    const host = desktopBridge()?.host;
    if (!host) return;
    let cancelled = false;
    const unsubscribe = host.subscribe((next) => {
      if (!cancelled) setStatus(next);
    });
    void host.getStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return status;
}

/** 이 PC 서버에 들어가는 주소인지 (localhost·127.0.0.1 의 그 포트). */
export function isOwnHostUrl(url: string, status: HostStatus): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      Number(parsed.port || 80) === status.port
    );
  } catch {
    return false;
  }
}

/**
 * 남에게 알려 줄 이 PC 서버의 주소 — 공개 주소가 있으면 그것, 없으면 공유기 안 주소.
 * localhost 는 받는 사람의 기기 자신을 가리키므로 쓰지 않는다.
 */
export function shareableHostUrl(status: HostStatus): string | null {
  if (status.tunnel.state === 'on' && status.tunnel.url) return status.tunnel.url;
  return status.lanUrls[0] ?? null;
}

/** PC 앱 호출이 실패했을 때 보여 줄 문장. Electron 이 앞에 붙이는 "Error invoking remote method …" 를 뗀다. */
export function desktopErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback;
}
