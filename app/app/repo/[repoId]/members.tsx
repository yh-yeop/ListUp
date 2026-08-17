import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import {
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  formatRelativeTime,
  type Member,
  type RepoSummary,
} from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  ErrorNotice,
  Loading,
  Row,
  Screen,
  Title,
} from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notify } from '../../../src/lib/dialogs';
import { useAsync } from '../../../src/lib/useAsync';
import { useAuth } from '../../../src/state/auth';
import { fontSize, spacing, useTheme } from '../../../src/theme';

export default function MembersScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const { user } = useAuth();
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const state = useAsync<{ repo: RepoSummary; members: Member[] }>(async () => {
    const [{ repo }, { members }] = await Promise.all([
      api.getRepo(repoId),
      api.listMembers(repoId),
    ]);
    return { repo, members };
  }, [repoId]);

  const repo = state.data?.repo;
  const isOwner = repo?.role === 'owner';

  async function changeRole(member: Member) {
    const next = member.role === 'viewer' ? 'editor' : 'viewer';
    const ok = await confirmAction({
      title: `${member.displayName} 님을 ${ROLE_LABEL[next]} 권한으로 바꿀까요?`,
      message: ROLE_DESCRIPTION[next],
      confirmLabel: '바꾸기',
    });
    if (!ok) return;

    setBusyUser(member.userId);
    try {
      await api.setMemberRole(repoId, member.userId, next);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '권한을 바꾸지 못했습니다.');
    } finally {
      setBusyUser(null);
    }
  }

  async function removeMember(member: Member) {
    const ok = await confirmAction({
      title: `${member.displayName} 님을 내보낼까요?`,
      message: '이 사람은 더 이상 저장소를 볼 수 없게 됩니다.',
      confirmLabel: '내보내기',
      destructive: true,
    });
    if (!ok) return;

    setBusyUser(member.userId);
    try {
      await api.removeMember(repoId, member.userId);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '내보내지 못했습니다.');
    } finally {
      setBusyUser(null);
    }
  }

  async function leave() {
    if (!user) return;
    const ok = await confirmAction({
      title: '이 저장소에서 나갈까요?',
      message: '다시 들어오려면 새 초대 코드가 필요합니다.',
      confirmLabel: '나가기',
      destructive: true,
    });
    if (!ok) return;

    try {
      await api.removeMember(repoId, user.id);
      router.replace('/repos');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '나가지 못했습니다.');
    }
  }

  async function deleteRepo() {
    const ok = await confirmAction({
      title: '저장소를 삭제할까요?',
      message: '모든 파일과 변경 이력이 사라집니다. 되돌릴 수 없습니다.',
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;

    try {
      await api.deleteRepo(repoId);
      router.replace('/repos');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '삭제하지 못했습니다.');
    }
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
      <Stack.Screen options={{ title: '멤버' }} />
      <Title>멤버</Title>
      <RepoNav repoId={repoId} openProposals={repo?.openProposalCount} />

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data ? (
        <>
          <Card padded={false} style={{ paddingVertical: spacing.sm }}>
            {state.data.members.map((member, index) => (
              <View key={member.userId}>
                {index > 0 ? <Divider /> : null}
                <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Row gap={spacing.sm}>
                        <Body style={{ fontWeight: '600' }}>{member.displayName}</Body>
                        {member.userId === user?.id ? <Caption>(나)</Caption> : null}
                      </Row>
                      {member.email ? <Caption>{member.email}</Caption> : null}
                      <Caption>{formatRelativeTime(member.joinedAt)} 참여</Caption>
                    </View>
                    <Badge
                      label={ROLE_LABEL[member.role]}
                      tone={member.role === 'owner' ? 'accent' : 'neutral'}
                    />
                  </Row>

                  {isOwner && member.role !== 'owner' ? (
                    <Row gap={spacing.sm} wrap>
                      <Button
                        label={member.role === 'viewer' ? '편집 권한 주기' : '열람 권한으로'}
                        variant="secondary"
                        compact
                        loading={busyUser === member.userId}
                        onPress={() => void changeRole(member)}
                      />
                      <Button
                        label="내보내기"
                        variant="danger"
                        compact
                        onPress={() => void removeMember(member)}
                      />
                    </Row>
                  ) : null}
                </View>
              </View>
            ))}
          </Card>

          <Card style={{ gap: spacing.md }}>
            <Body style={{ fontWeight: '600', fontSize: fontSize.md }}>권한 안내</Body>
            {(['viewer', 'editor', 'owner'] as const).map((role) => (
              <View key={role} style={{ gap: 2 }}>
                <Body style={{ fontWeight: '600', fontSize: fontSize.sm }}>{ROLE_LABEL[role]}</Body>
                <Caption>{ROLE_DESCRIPTION[role]}</Caption>
              </View>
            ))}
          </Card>

          <Card style={{ gap: spacing.md }}>
            {isOwner ? (
              <Button
                label="저장소 삭제"
                variant="danger"
                icon="trash-outline"
                onPress={deleteRepo}
                full
              />
            ) : (
              <Button
                label="저장소에서 나가기"
                variant="danger"
                icon="exit-outline"
                onPress={leave}
                full
              />
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
