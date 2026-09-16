import { router } from 'expo-router';
import { useState } from 'react';
import type { HostState, HostStatus } from '@listup/shared';
import { desktopBridge, desktopErrorMessage, isOwnHostUrl } from '../lib/desktop';
import { useAuth } from '../state/auth';
import { serverUrl } from '../state/servers';
import { monoFont, spacing, useTheme } from '../theme';
import { Badge, Body, Button, Caption, Card, ErrorNotice, Row } from './ui';

export const HOST_STATE_BADGE: Record<HostState, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }> = {
  stopped: { label: '꺼짐', tone: 'neutral' },
  starting: { label: '켜는 중', tone: 'accent' },
  running: { label: '실행 중', tone: 'success' },
  stopping: { label: '끄는 중', tone: 'neutral' },
  error: { label: '오류', tone: 'danger' },
};

/**
 * 이 PC 서버로 들어간다 — 서버 목록에 `이 PC`(localhost) 항목이 없으면 더하고 그 서버로 전환한다.
 * 자기 PC 에는 공개 주소를 돌지 않고 곧장 붙는다.
 */
export function useEnterOwnServer(): (status: HostStatus) => Promise<void> {
  const { servers, saveServer, switchServer } = useAuth();
  return async (status) => {
    const existing = servers.find((entry) => isOwnHostUrl(serverUrl(entry), status));
    const id = existing?.id ?? (await saveServer({ url: status.localUrl, label: '이 PC' }));
    await switchServer(id);
  };
}

/** 서버 목록 맨 위 — 이 PC 에서 연 서버. PC 앱에서만 보인다. */
export function HostCard({ status }: { status: HostStatus }) {
  const { colors } = useTheme();
  const enterOwnServer = useEnterOwnServer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = desktopBridge()?.host;
  if (!host) return null;

  const badge = HOST_STATE_BADGE[status.state];
  const running = status.state === 'running';
  const address = status.tunnel.state === 'on' ? status.tunnel.url : running ? status.lanUrls[0] ?? status.localUrl : null;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(desktopErrorMessage(err, '하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: spacing.md }}>
      <Row gap={spacing.sm} wrap>
        <Body style={{ fontWeight: '600' }}>이 PC 에서 서버 열기</Body>
        <Badge label={badge.label} tone={badge.tone} />
      </Row>
      {address ? (
        <Caption numberOfLines={1} style={{ fontFamily: monoFont, color: colors.textMuted }}>
          {address}
        </Caption>
      ) : (
        <Caption>이 PC 를 ListUp 서버로 씁니다. 켜 두는 동안 초대한 사람들이 들어올 수 있습니다.</Caption>
      )}
      {status.error ? <ErrorNotice message={status.error} /> : null}
      {error ? <ErrorNotice message={error} /> : null}
      <Row gap={spacing.sm} wrap>
        {running ? (
          <Button label="들어가기" icon="log-in-outline" compact loading={busy} onPress={() => void act(() => enterOwnServer(status))} />
        ) : (
          <Button
            label="서버 켜기"
            icon="power"
            compact
            loading={busy || status.state === 'starting'}
            disabled={status.state === 'stopping'}
            onPress={() => void act(() => host.start())}
          />
        )}
        <Button label="관리" variant="secondary" icon="options-outline" compact onPress={() => router.push('/host')} />
      </Row>
    </Card>
  );
}
