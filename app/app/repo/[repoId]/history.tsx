import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { RefreshControl, View } from 'react-native';
import { formatBytes, formatRelativeTime, type RepoSummary, type Snapshot } from '@listup/shared';
import {
  Body,
  Caption,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { api } from '../../../src/api/client';
import { useAsync } from '../../../src/lib/useAsync';
import { spacing, useTheme } from '../../../src/theme';

export default function HistoryScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();

  const state = useAsync<{ repo: RepoSummary; snapshots: Snapshot[] }>(async () => {
    const [{ repo }, { snapshots }] = await Promise.all([
      api.getRepo(repoId),
      api.history(repoId),
    ]);
    return { repo, snapshots };
  }, [repoId]);

  const headId = state.data?.repo.headSnapshotId;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={state.refreshing}
          onRefresh={state.refresh}
          tintColor={colors.textMuted}
        />
      }
    >
      <Stack.Screen options={{ title: '변경 이력' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>변경 이력</Title>
        <Subtitle>
          파일이 바뀔 때마다 그 시점의 전체 목록이 남습니다. 지운 파일도 이전 시점에서는 그대로
          볼 수 있습니다.
        </Subtitle>
      </View>
      <RepoNav repoId={repoId} openProposals={state.data?.repo.openProposalCount} />

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && state.data.snapshots.length > 0 ? (
        <Card padded={false} style={{ paddingVertical: spacing.sm }}>
          {state.data.snapshots.map((snapshot, index) => (
            <View key={snapshot.id}>
              {index > 0 ? <Divider /> : null}
              <View
                style={{
                  flexDirection: 'row',
                  gap: spacing.md,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                }}
              >
                <Ionicons
                  name={snapshot.id === headId ? 'radio-button-on' : 'ellipse-outline'}
                  size={16}
                  color={snapshot.id === headId ? colors.accent : colors.textFaint}
                  style={{ marginTop: 2 }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Body>{snapshot.message || '변경'}</Body>
                  <Row gap={spacing.md} wrap>
                    <Caption>{snapshot.author.displayName}</Caption>
                    <Caption>{formatRelativeTime(snapshot.createdAt)}</Caption>
                    <Caption>
                      파일 {snapshot.fileCount}개 · {formatBytes(snapshot.totalSize)}
                    </Caption>
                  </Row>
                </View>
                {snapshot.id === headId ? <Caption>현재</Caption> : null}
              </View>
            </View>
          ))}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon="time-outline"
            title="아직 변경 이력이 없습니다"
            description="파일을 올리거나 제안을 반영하면 여기에 기록이 쌓입니다."
          />
        </Card>
      )}
    </Screen>
  );
}
