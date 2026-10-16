import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { formatRelativeTime, type ActivityItem, type ActivityKind } from '@listup/shared';
import { Body, Caption, Card, Divider, EmptyState, ErrorNotice, Loading, Screen, Subtitle, Title } from '../src/components/ui';
import { api } from '../src/api/client';
import { loadSeenAt, markSeen } from '../src/lib/activity';
import { useAsync } from '../src/lib/useAsync';
import { useAuth } from '../src/state/auth';
import { fontSize, spacing, useTheme } from '../src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const KIND: Record<ActivityKind, { icon: IconName; verb: string }> = {
  commit: { icon: 'cloud-upload-outline', verb: '파일을 바꿨습니다' },
  'proposal-opened': { icon: 'git-pull-request-outline', verb: '변경 제안을 올렸습니다' },
  'proposal-merged': { icon: 'git-merge-outline', verb: '제안을 반영했습니다' },
  'proposal-closed': { icon: 'close-circle-outline', verb: '제안을 닫았습니다' },
  comment: { icon: 'chatbubble-outline', verb: '의견을 남겼습니다' },
};

/**
 * 새 소식 — 내 저장소들에서 최근에 있었던 일. 들어오면 "읽음"으로 적고, 그 전에 읽지 않았던 것은 표시해 둔다.
 */
export default function ActivityScreen() {
  const { colors } = useTheme();
  const { activeServer } = useAuth();
  const serverId = activeServer?.id ?? 'default';
  const [seenAt, setSeenAt] = useState<number | null>(null);

  const state = useAsync<ActivityItem[]>(async () => (await api.activity(0, 100)).items, []);

  useEffect(() => {
    void loadSeenAt(serverId).then((at) => {
      setSeenAt(at);
      void markSeen(serverId);
    });
  }, [serverId]);

  const open = (item: ActivityItem) => {
    if (item.proposalId) router.push(`/proposal/${item.proposalId}`);
    else router.push(`/repo/${item.repoId}/history`);
  };

  return (
    <Screen refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />}>
      <Stack.Screen options={{ title: '새 소식' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>새 소식</Title>
        <Subtitle>내가 속한 저장소들에서 최근에 있었던 일입니다. 누르면 그 제안이나 변경 이력으로 갑니다.</Subtitle>
      </View>
      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && state.data.length > 0 ? (
        <Card padded={false} style={{ paddingVertical: spacing.sm }}>
          {state.data.map((item, index) => {
            const fresh = seenAt !== null && !item.mine && item.at > seenAt;
            const { icon, verb } = KIND[item.kind];
            return (
              <View key={`${item.kind}-${item.at}-${item.proposalId ?? item.repoId}-${index}`}>
                {index > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() => open(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.actor.displayName} 님이 ${item.repoName} 에서 ${verb}: ${item.title}`}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    backgroundColor: pressed ? colors.surfaceAlt : fresh ? colors.accentSoft : 'transparent',
                  })}
                >
                  <Ionicons name={icon} size={20} color={fresh ? colors.accent : colors.textMuted} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Body style={{ fontWeight: fresh ? '600' : '400' }}>
                      {item.mine ? '내가' : `${item.actor.displayName} 님이`} {verb}
                      {item.proposalNumber ? ` (#${item.proposalNumber})` : ''}
                    </Body>
                    <Body muted numberOfLines={2} style={{ fontSize: fontSize.sm }}>
                      {item.title || '(설명 없음)'}
                    </Body>
                    <Caption>
                      {item.repoName} · {formatRelativeTime(item.at)}
                    </Caption>
                  </View>
                </Pressable>
              </View>
            );
          })}
        </Card>
      ) : (
        <Card>
          <EmptyState icon="notifications-off-outline" title="아직 소식이 없습니다" description="저장소에서 파일이 바뀌거나 제안·의견이 올라오면 여기에 보입니다." />
        </Card>
      )}
    </Screen>
  );
}
