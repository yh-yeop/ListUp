import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, View } from 'react-native';
import { formatBytes, formatRelativeTime, type RepoSummary, type Snapshot } from '@listup/shared';
import {
  Body,
  Button,
  Caption,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  LoadMoreFooter,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { api } from '../../../src/api/client';
import { useAsync } from '../../../src/lib/useAsync';
import { useMorePages, type Page } from '../../../src/lib/useMorePages';
import { spacing, useTheme } from '../../../src/theme';

type Cursor = { before: number; beforeId: string };

export default function HistoryScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();

  const state = useAsync<{ repo: RepoSummary; page: Page<Snapshot, Cursor> }>(async () => {
    const [{ repo }, { snapshots, next }] = await Promise.all([
      api.getRepo(repoId),
      api.history(repoId),
    ]);
    return { repo, page: { items: snapshots, next } };
  }, [repoId]);

  const headId = state.data?.repo.headSnapshotId;
  const pages = useMorePages(state.data?.page, async (cursor: Cursor) => {
    const { snapshots, next } = await api.history(repoId, cursor);
    return { items: snapshots, next };
  });
  const snapshots = pages.items;

  /** 현재 시점은 그냥 파일 화면으로, 과거 시점은 읽기 전용 보기로 연다. */
  function openSnapshot(snapshot: Snapshot) {
    if (snapshot.id === headId) {
      router.push(`/repo/${repoId}`);
      return;
    }
    router.push(
      `/repo/${repoId}?snapshot=${encodeURIComponent(snapshot.id)}&message=${encodeURIComponent(
        snapshot.message,
      )}&at=${snapshot.createdAt}`,
    );
  }

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
          파일이 바뀔 때마다 그 시점의 전체 목록이 남습니다. 시점을 누르면 그때의 파일을 볼 수
          있고, 지운 파일도 이전 시점에서는 그대로 내려받을 수 있습니다.
        </Subtitle>
      </View>
      <RepoNav repoId={repoId} openProposals={state.data?.repo.openProposalCount} />
      <Button
        label="휴지통"
        icon="trash-outline"
        variant="secondary"
        compact
        onPress={() => router.push(`/repo/${repoId}/trash`)}
      />

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && snapshots.length > 0 ? (
        <Card padded={false} style={{ paddingVertical: spacing.sm }}>
          {snapshots.map((snapshot, index) => (
            <View key={snapshot.id}>
              {index > 0 ? <Divider /> : null}
              <Pressable
                onPress={() => openSnapshot(snapshot)}
                accessibilityRole="button"
                accessibilityLabel={`${snapshot.message || '변경'} 시점의 파일 보기`}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                })}
              >
                <Ionicons
                  name={snapshot.id === headId ? 'radio-button-on' : 'ellipse-outline'}
                  size={16}
                  color={snapshot.id === headId ? colors.accent : colors.textFaint}
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
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </Pressable>
            </View>
          ))}

          {pages.next ? (
            <LoadMoreFooter onPress={pages.loadMore} loading={pages.loadingMore} disabled={state.refreshing} />
          ) : null}
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
