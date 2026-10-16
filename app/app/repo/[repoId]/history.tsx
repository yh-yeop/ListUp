import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { formatBytes, formatRelativeTime, type HealthResponse, type RepoSummary, type Snapshot } from '@listup/shared';
import {
  Body,
  Button,
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
import { ApiError, api, getServerInfo } from '../../../src/api/client';
import { describeRetention } from '../../../src/lib/retention';
import { notifyError } from '../../../src/lib/dialogs';
import { useAsync } from '../../../src/lib/useAsync';
import { spacing, useTheme } from '../../../src/theme';

type Cursor = { before: number; beforeId: string };

interface HistoryPage {
  snapshots: Snapshot[];
  /** 더 볼 게 있으면 다음 요청에 넘길 커서. */
  next: Cursor | null;
}

/**
 * '더 보기' 로 이어 받은 페이지들. `from` 은 이 페이지들이 이어지는 첫 페이지의 목록 —
 * 새로고침으로 첫 페이지가 바뀌면 참조가 달라지므로 이어 받은 것은 버린다.
 */
interface ExtraPages extends HistoryPage {
  from: Snapshot[];
}

export default function HistoryScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 서버의 이력 보존 설정. 1.4.0 서버부터(그 전 서버는 null — 안내도 용량 화면도 없다).
  const [retention, setRetention] = useState<HealthResponse['history'] | null | undefined>(undefined);
  useEffect(() => {
    void getServerInfo().then((info) => setRetention(info.history ?? null));
  }, []);

  const state = useAsync<{ repo: RepoSummary } & HistoryPage>(async () => {
    const [{ repo }, { snapshots, next }] = await Promise.all([
      api.getRepo(repoId),
      api.history(repoId),
    ]);
    return { repo, snapshots, next };
  }, [repoId]);

  const headId = state.data?.repo.headSnapshotId;
  const firstPage = state.data?.snapshots;
  const extraPages = extra && extra.from === firstPage ? extra : null;
  const snapshots = [...(firstPage ?? []), ...(extraPages?.snapshots ?? [])];
  const next = extraPages ? extraPages.next : (state.data?.next ?? null);

  async function loadMore() {
    if (!firstPage || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.history(repoId, next);
      setExtra((prev) => ({
        from: firstPage,
        snapshots: [...(prev && prev.from === firstPage ? prev.snapshots : []), ...page.snapshots],
        next: page.next,
      }));
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '더 불러오지 못했습니다.');
    } finally {
      setLoadingMore(false);
    }
  }

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
          파일이 바뀔 때마다 그 시점의 전체 목록이 남습니다. 시점을 누르면 그때의 파일을 보고 받을 수
          있고, 편집 권한이 있으면 저장소를 그 시점으로 되돌릴 수 있습니다.
        </Subtitle>
        {retention !== undefined ? (
          <Row gap={spacing.sm} wrap style={{ justifyContent: 'space-between' }}>
            <Caption style={{ flex: 1 }}>{describeRetention(retention ?? undefined)}</Caption>
            <Button label="용량 보기" icon="pie-chart-outline" variant="secondary" compact onPress={() => router.push(`/repo/${repoId}/storage`)} />
          </Row>
        ) : null}
      </View>
      <RepoNav repoId={repoId} openProposals={state.data?.repo.openProposalCount} />

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

          {next ? (
            <>
              <Divider />
              <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs }}>
                <Button
                  label="더 보기"
                  icon="chevron-down"
                  variant="secondary"
                  compact
                  full
                  onPress={() => void loadMore()}
                  loading={loadingMore}
                  disabled={state.refreshing}
                />
              </View>
            </>
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
