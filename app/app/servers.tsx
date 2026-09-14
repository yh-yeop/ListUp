import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { formatRelativeTime } from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  ErrorNotice,
  IconButton,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { useAuth } from '../src/state/auth';
import {
  describeUrl,
  isDefaultServer,
  serverTitle,
  serverUrl,
  type ServerEntry,
} from '../src/state/servers';
import { monoFont, spacing, useTheme } from '../src/theme';

/** 이 기기가 기억하는 서버 목록. 로그인 전후 모두 들어올 수 있다. */
export default function ServersScreen() {
  const { servers, activeServer, switchServer } = useAuth();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <View style={{ gap: spacing.md }}>
        {servers.map((entry) => (
          <ServerCard
            key={entry.id}
            entry={entry}
            active={entry.id === activeServer.id}
            switching={switchingId === entry.id}
            disabled={switchingId !== null}
            onPress={() => void choose(entry)}
          />
        ))}
      </View>

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

function ServerCard({
  entry,
  active,
  switching,
  disabled,
  onPress,
}: {
  entry: ServerEntry;
  active: boolean;
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
            {switching ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          </Row>
          {showAddress ? (
            <Caption numberOfLines={1} style={{ fontFamily: monoFont, color: colors.textMuted }}>
              {address}
            </Caption>
          ) : null}
          <Caption>
            {status}
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
