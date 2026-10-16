import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import {
  PROPOSAL_STATUS_LABEL,
  formatRelativeTime,
  type Proposal,
  type ProposalStatus,
  type RepoSummary,
} from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  Row,
  Screen,
  Title,
} from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api } from '../../../src/api/client';
import { notifyError } from '../../../src/lib/dialogs';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, radius, spacing, useTheme } from '../../../src/theme';

type Filter = 'open' | 'all';

type Cursor = { before: number };

interface ProposalPage {
  proposals: Proposal[];
  /** 더 볼 게 있으면 다음 요청에 넘길 커서. */
  next: Cursor | null;
}

/**
 * '더 보기' 로 이어 받은 페이지들. `from` 은 이 페이지들이 이어지는 첫 페이지의 목록 —
 * 새로고침·필터 변경으로 첫 페이지가 바뀌면 참조가 달라지므로 이어 받은 것은 버린다.
 */
interface ExtraPages extends ProposalPage {
  from: Proposal[];
}

export default function ProposalsScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<Filter>('open');
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const status = filter === 'open' ? 'open' : undefined;

  const state = useAsync<{ repo: RepoSummary } & ProposalPage>(async () => {
    const [{ repo }, { proposals, next }] = await Promise.all([
      api.getRepo(repoId),
      api.listProposals(repoId, status),
    ]);
    return { repo, proposals, next };
  }, [repoId, filter]);

  const firstPage = state.data?.proposals;
  const extraPages = extra && extra.from === firstPage ? extra : null;
  const proposals = [...(firstPage ?? []), ...(extraPages?.proposals ?? [])];
  const next = extraPages ? extraPages.next : (state.data?.next ?? null);

  async function loadMore() {
    if (!firstPage || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listProposals(repoId, status, next);
      setExtra((prev) => ({
        from: firstPage,
        proposals: [...(prev && prev.from === firstPage ? prev.proposals : []), ...page.proposals],
        next: page.next,
      }));
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '더 불러오지 못했습니다.');
    } finally {
      setLoadingMore(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      state.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repoId, filter]),
  );

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
      <Stack.Screen options={{ title: '변경 제안' }} />

      <Title>변경 제안</Title>
      <RepoNav repoId={repoId} openProposals={state.data?.repo.openProposalCount} />

      <Row style={{ justifyContent: 'space-between' }} wrap>
        <Row gap={spacing.xs}>
          {(['open', 'all'] as Filter[]).map((value) => {
            const active = filter === value;
            return (
              <Pressable
                key={value}
                onPress={() => setFilter(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm - 2,
                  borderRadius: radius.pill,
                  backgroundColor: active ? colors.accentSoft : colors.surfaceAlt,
                }}
              >
                <Body style={{ color: active ? colors.accent : colors.textMuted, fontSize: fontSize.sm }}>
                  {value === 'open' ? '검토 중' : '전체'}
                </Body>
              </Pressable>
            );
          })}
        </Row>
        <Button
          label="변경 제안 만들기"
          icon="add"
          compact
          onPress={() => router.push(`/repo/${repoId}/new-proposal`)}
        />
      </Row>

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && proposals.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          {proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
          {next ? (
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
          ) : null}
        </View>
      ) : (
        <Card>
          <EmptyState
            icon="git-pull-request-outline"
            title={filter === 'open' ? '검토 중인 제안이 없습니다' : '아직 제안이 없습니다'}
            description="파일을 바꾸고 싶지만 직접 반영하기 어렵다면, 변경 제안을 올려 편집자의 검토를 받을 수 있습니다."
            action={
              <Button
                label="변경 제안 만들기"
                onPress={() => router.push(`/repo/${repoId}/new-proposal`)}
              />
            }
          />
        </Card>
      )}
    </Screen>
  );
}

const STATUS_TONE: Record<ProposalStatus, 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  merged: 'success',
  closed: 'neutral',
};

const STATUS_ICON: Record<ProposalStatus, 'ellipse-outline' | 'checkmark-circle' | 'close-circle'> = {
  open: 'ellipse-outline',
  merged: 'checkmark-circle',
  closed: 'close-circle',
};

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => router.push(`/proposal/${proposal.id}`)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ gap: spacing.sm }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={spacing.sm} style={{ flex: 1 }}>
            <Caption style={{ fontWeight: '700' }}>#{proposal.number}</Caption>
            <Body numberOfLines={2} style={{ fontWeight: '600', flex: 1 }}>
              {proposal.title}
            </Body>
          </Row>
          <Badge
            label={PROPOSAL_STATUS_LABEL[proposal.status]}
            tone={STATUS_TONE[proposal.status]}
            icon={STATUS_ICON[proposal.status]}
          />
        </Row>

        <Row gap={spacing.md} wrap>
          <Caption>{proposal.author.displayName}</Caption>
          <Caption>{formatRelativeTime(proposal.createdAt)}</Caption>
          <Row gap={4}>
            <Ionicons name="document-outline" size={12} color={colors.textFaint} />
            <Caption>{proposal.changeCount}개 파일</Caption>
          </Row>
          {proposal.commentCount > 0 ? (
            <Row gap={4}>
              <Ionicons name="chatbubble-outline" size={12} color={colors.textFaint} />
              <Caption>{proposal.commentCount}</Caption>
            </Row>
          ) : null}
        </Row>
      </Card>
    </Pressable>
  );
}
