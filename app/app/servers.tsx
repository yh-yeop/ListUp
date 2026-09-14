import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { formatRelativeTime } from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  EmptyState,
  ErrorNotice,
  IconButton,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { credentialsSupported, loadLogin } from '../src/lib/credentials';
import { openReleasePage, updateChecksEnabled } from '../src/lib/updates';
import { useAuth } from '../src/state/auth';
import {
  checkServer,
  describeUrl,
  isDefaultServer,
  ServerCheckError,
  serverTitle,
  serverUrl,
  type ServerCheck,
  type ServerEntry,
} from '../src/state/servers';
import { monoFont, spacing, useTheme } from '../src/theme';

/** 이 기기가 기억하는 서버 목록. 로그인 전후 모두 들어올 수 있다. */
export default function ServersScreen() {
  const { servers, activeServer, switchServer } = useAuth();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checks = useServerChecks(servers);
  const savedLogins = useSavedLogins(servers);

  const choose = async (entry: ServerEntry) => {
    if (switchingId) return;
    setError(null);
    setSwitchingId(entry.id);
    try {
      // 성공하면 _layout 이 스택을 비우고 그 서버로 들여보낸다.
      await switchServer(entry.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '서버를 바꾸지 못했습니다.');
      setSwitchingId(null);
      // 앱이 서버보다 오래돼 들어갈 수 없다 — 업데이트가 꼭 필요하므로 릴리즈 페이지를 바로 연다.
      if (err instanceof ServerCheckError && err.check.status === 'app-older' && updateChecksEnabled()) {
        void openReleasePage();
      }
    }
  };

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>서버</Title>
        <Subtitle>
          들어갈 서버를 고릅니다. 계정은 서버마다 따로이고, 한 번 로그인한 서버는 다시 고를 때
          로그인하지 않아도 됩니다.
        </Subtitle>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      {servers.length === 0 ? (
        <EmptyState
          icon="server-outline"
          title="아직 기억하는 서버가 없습니다"
          description="서버 추가로 들어갈 ListUp 서버의 주소를 넣으세요. 주소는 초대 코드를 준 사람에게 받습니다."
        />
      ) : (
        <View style={{ gap: spacing.md }}>
          {servers.map((entry) => (
            <ServerCard
              key={entry.id}
              entry={entry}
              active={entry.id === activeServer?.id}
              check={checks[entry.id]}
              hasSavedLogin={savedLogins.has(entry.id)}
              switching={switchingId === entry.id}
              disabled={switchingId !== null}
              onPress={() => void choose(entry)}
            />
          ))}
        </View>
      )}

      <Button
        label="서버 추가"
        variant="secondary"
        icon="add"
        onPress={() => router.push('/server')}
        disabled={switchingId !== null}
      />
    </Screen>
  );
}

/**
 * 목록을 열 때마다 서버마다 연결을 확인한다 — 마인크래프트 서버 목록이 서버마다 핑을 보내듯.
 * 눌러 보기 전에 꺼진 서버와 버전이 다른 서버를 알 수 있다.
 */
function useServerChecks(servers: ServerEntry[]): Record<string, ServerCheck> {
  const [checks, setChecks] = useState<Record<string, ServerCheck>>({});
  const serversRef = useRef(servers);
  serversRef.current = servers;
  // 목록 저장(마지막 접속 시각 등)마다 다시 확인하지 않게, 서버나 주소가 바뀔 때만 다시 한다.
  const targetsKey = servers.map((entry) => `${entry.id} ${serverUrl(entry)}`).join('\n');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setChecks({});
      for (const entry of serversRef.current) {
        void checkServer(serverUrl(entry)).then((result) => {
          if (!cancelled) setChecks((prev) => ({ ...prev, [entry.id]: result }));
        });
      }
      return () => {
        cancelled = true;
      };
    }, [targetsKey]),
  );

  return checks;
}

/** 로그인 정보를 저장해 둔 서버. 목록을 열 때마다 다시 읽는다. */
function useSavedLogins(servers: ServerEntry[]): Set<string> {
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const idsKey = servers.map((entry) => entry.id).join(' ');

  useFocusEffect(
    useCallback(() => {
      if (!credentialsSupported()) return;
      let cancelled = false;
      void Promise.all(
        serversRef.current.map(async (entry) => ((await loadLogin(entry.id)) ? entry.id : null)),
      ).then((ids) => {
        if (!cancelled) setSaved(new Set(ids.filter((id): id is string => id !== null)));
      });
      return () => {
        cancelled = true;
      };
    }, [idsKey]),
  );

  return saved;
}

const CHECK_BADGE: Record<
  ServerCheck['status'],
  { label: string; tone: 'success' | 'warning' | 'danger' }
> = {
  ok: { label: '연결됨', tone: 'success' },
  unreachable: { label: '닿지 않음', tone: 'warning' },
  'server-older': { label: '서버가 오래됨', tone: 'danger' },
  'app-older': { label: '앱 업데이트 필요', tone: 'danger' },
};

function ServerCard({
  entry,
  active,
  check,
  hasSavedLogin,
  switching,
  disabled,
  onPress,
}: {
  entry: ServerEntry;
  active: boolean;
  /** 아직 확인 중이면 undefined. */
  check: ServerCheck | undefined;
  hasSavedLogin: boolean;
  switching: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const title = serverTitle(entry);
  const address = describeUrl(serverUrl(entry));
  // 이름을 붙이지 않은 서버는 제목이 곧 주소라 한 번만 보여준다.
  const showAddress = title !== address;
  const status = entry.token && entry.user ? `${entry.user.displayName} 님으로 로그인됨` : '로그인 안 됨';
  const lastUsed = entry.lastUsedAt ? ` · ${formatRelativeTime(entry.lastUsedAt)}` : '';

  return (
    <Card padded={false} style={active ? { borderColor: colors.accent } : undefined}>
      <Row style={{ alignItems: 'stretch' }} gap={0}>
        <Pressable
          onPress={onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${title} 서버로 들어가기`}
          accessibilityState={{ selected: active, busy: switching, disabled }}
          style={({ pressed }) => ({
            flex: 1,
            padding: spacing.lg,
            gap: spacing.xs,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Row gap={spacing.sm} wrap>
            <Body style={{ fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
              {title}
            </Body>
            {active ? <Badge label="현재" tone="accent" /> : null}
            {isDefaultServer(entry) ? <Badge label="기본" /> : null}
            {check ? (
              <Badge label={CHECK_BADGE[check.status].label} tone={CHECK_BADGE[check.status].tone} />
            ) : null}
            {switching ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          </Row>
          {showAddress ? (
            <Caption numberOfLines={1} style={{ fontFamily: monoFont, color: colors.textMuted }}>
              {address}
            </Caption>
          ) : null}
          <Caption>
            {status}
            {hasSavedLogin ? ' · 계정 저장됨' : ''}
            {lastUsed}
          </Caption>
        </Pressable>
        <View style={{ justifyContent: 'center', paddingRight: spacing.sm }}>
          <IconButton
            icon="settings-outline"
            label={`${title} 서버 설정`}
            onPress={() => router.push({ pathname: '/server', params: { id: entry.id } })}
          />
        </View>
      </Row>
    </Card>
  );
}
