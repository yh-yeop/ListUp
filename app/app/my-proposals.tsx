import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { formatRelativeTime, type MyProposal } from '@listup/shared';
import { Badge, Body, Caption, Card, EmptyState, ErrorNotice, Loading, Row, Screen, Title } from '../src/components/ui';
import { ProposalStatusBadge } from '../src/components/ProposalStatusBadge';
import { ApiError, api } from '../src/api/client';
import { useAsync } from '../src/lib/useAsync';
import { spacing, useTheme } from '../src/theme';

/**
 * 내 제안 — 내가 올린 제안을 저장소를 가로질러 본다. 열람자가 올린 제안이 반영·닫혔는지, 누가 의견을
 * 달았는지를 저장소마다 찾아가지 않고 알게 한다. 새 소식이 있는 것을 위로.
 */
export default function MyProposalsScreen() {
  const { colors } = useTheme();
  const state = useAsync(async () => {
    try {
      const { proposals } = await api.myProposals();
      // 서버는 최근에 바뀐 것부터 준다. 새 소식이 있는 것만 앞으로 끌어올린다(정렬은 안정적).
      return [...proposals].sort((a, b) => Number(b.unseen) - Number(a.unseen));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('이 서버에는 아직 이 기능이 없습니다. 서버 주인에게 ListUp 서버를 1.8 이상으로 업데이트해 달라고 부탁하세요.');
      }
      throw err;
    }
  }, []);

  // 상세를 보고 돌아오면 새 소식 표시가 풀려 있어야 한다.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      state.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const proposals = state.data ?? [];
  const unseen = proposals.filter((p) => p.unseen).length;

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />
      }
    >
      <View style={{ gap: spacing.xs }}>
        <Title>내 제안</Title>
        <Caption>
          {unseen > 0 ? `새 소식 ${unseen}건 — 눌러서 열면 표시가 사라집니다.` : '내가 올린 변경 제안이 어떻게 됐는지 봅니다.'}
        </Caption>
      </View>

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : proposals.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          {proposals.map((proposal) => (
            <MyProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </View>
      ) : (
        <Card>
          <EmptyState
            icon="git-pull-request-outline"
            title="올린 제안이 없습니다"
            description="저장소의 파일을 바꾸고 싶은데 직접 올릴 권한이 없다면, 그 저장소에서 변경 제안을 만들 수 있습니다."
          />
        </Card>
      )}
    </Screen>
  );
}

/** 결정한 사람과 때. 수준 5 이전에 결정된 제안은 사람을 모른다. */
function outcome(proposal: MyProposal): string {
  if (proposal.status === 'open') return `${formatRelativeTime(proposal.createdAt)} 올림 · 검토 중`;
  const verb = proposal.status === 'merged' ? '반영' : '닫음';
  const when = formatRelativeTime(proposal.decidedAt ?? proposal.updatedAt);
  return proposal.decidedBy ? `${proposal.decidedBy.displayName} 님이 ${verb} · ${when}` : `${verb} · ${when}`;
}

function MyProposalCard({ proposal }: { proposal: MyProposal }) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => router.push(`/proposal/${proposal.id}`)}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ gap: spacing.sm }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={spacing.xs} style={{ flex: 1 }}>
            <Ionicons name="folder-outline" size={14} color={colors.textFaint} />
            <Caption numberOfLines={1} style={{ flex: 1 }}>
              {proposal.repoName}
            </Caption>
          </Row>
          {proposal.unseen ? <Badge label="새 소식" tone="accent" icon="notifications-outline" /> : null}
        </Row>

        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={spacing.sm} style={{ flex: 1 }}>
            <Caption style={{ fontWeight: '700' }}>#{proposal.number}</Caption>
            <Body numberOfLines={2} style={{ fontWeight: '600', flex: 1 }}>
              {proposal.title}
            </Body>
          </Row>
          <ProposalStatusBadge status={proposal.status} />
        </Row>

        <Row gap={spacing.md} wrap>
          <Caption>{outcome(proposal)}</Caption>
          {proposal.commentCount > 0 ? (
            <Row gap={spacing.xs}>
              <Ionicons name="chatbubble-outline" size={12} color={colors.textFaint} />
              <Caption>{proposal.commentCount}</Caption>
            </Row>
          ) : null}
        </Row>
      </Card>
    </Pressable>
  );
}
