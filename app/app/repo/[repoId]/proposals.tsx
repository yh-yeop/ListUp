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
import { api } from '../../../src/api/client';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, radius, spacing, useTheme } from '../../../src/theme';

type Filter = 'open' | 'all';

export default function ProposalsScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<Filter>('open');

  const state = useAsync<{ repo: RepoSummary; proposals: Proposal[] }>(async () => {
    const [{ repo }, { proposals }] = await Promise.all([
      api.getRepo(repoId),
      api.listProposals(repoId, filter === 'open' ? 'open' : undefined),
    ]);
    return { repo, proposals };
  }, [repoId, filter]);

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
          label="새 제안"
          icon="add"
          compact
          onPress={() => router.push(`/repo/${repoId}/new-proposal`)}
        />
      </Row>

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && state.data.proposals.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          {state.data.proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
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
