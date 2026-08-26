import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
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
  Field,
  Input,
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

/** 멤버 한 명에게 진행 중인 작업 — 해당 버튼에만 로딩을 표시한다. */
type MemberAction = 'role' | 'transfer' | 'remove';

export default function MembersScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const { user } = useAuth();
  const [busy, setBusy] = useState<{ userId: string; action: MemberAction } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const state = useAsync<{ repo: RepoSummary; members: Member[] }>(async () => {
    const [{ repo }, { members }] = await Promise.all([
      api.getRepo(repoId),
      api.listMembers(repoId),
    ]);
    return { repo, members };
  }, [repoId]);

  const repo = state.data?.repo;
  const isOwner = repo?.role === 'owner';

  // 서버 값이 바뀌었을 때만 입력란을 맞춘다 — 입력 중에 같은 값으로 새로고침돼도 그대로 둔다.
  const repoName = repo?.name;
  const repoDescription = repo?.description;
  useEffect(() => {
    if (repoName === undefined || repoDescription === undefined) return;
    setName(repoName);
    setDescription(repoDescription);
  }, [repoName, repoDescription]);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const changed =
    !!repo && (trimmedName !== repo.name || trimmedDescription !== repo.description);
  const canSave = changed && trimmedName.length > 0;

  const isBusy = (member: Member, action: MemberAction) =>
    busy?.userId === member.userId && busy.action === action;

  async function saveRepo() {
    if (!repo || !canSave || saving) return;
    setSaving(true);
    try {
      await api.updateRepo(repoId, { name: trimmedName, description: trimmedDescription });
      state.refresh();
      notify('저장소 정보를 저장했습니다.');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '저장소 정보를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(member: Member) {
    const next = member.role === 'viewer' ? 'editor' : 'viewer';
    const ok = await confirmAction({
      title: `${member.displayName} 님을 ${ROLE_LABEL[next]} 권한으로 바꿀까요?`,
      message: ROLE_DESCRIPTION[next],
      confirmLabel: '바꾸기',
    });
    if (!ok) return;

    setBusy({ userId: member.userId, action: 'role' });
    try {
      await api.setMemberRole(repoId, member.userId, next);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '권한을 바꾸지 못했습니다.');
    } finally {
      setBusy(null);
    }
  }

  async function transferOwnership(member: Member) {
    const ok = await confirmAction({
      title: `${member.displayName} 님을 소유자로 지정할까요?`,
      message:
        '소유권을 넘기면 나는 편집 권한으로 남습니다. 저장소 설정과 삭제, 멤버 관리는 새 소유자만 할 수 있게 됩니다.',
      confirmLabel: '소유자로 지정',
      destructive: true,
    });
    if (!ok) return;

    setBusy({ userId: member.userId, action: 'transfer' });
    try {
      await api.transferOwnership(repoId, member.userId);
      state.refresh();
      notify(`${member.displayName} 님이 새 소유자가 되었습니다.`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '소유권을 넘기지 못했습니다.');
    } finally {
      setBusy(null);
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

    setBusy({ userId: member.userId, action: 'remove' });
    try {
      await api.removeMember(repoId, member.userId);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '내보내지 못했습니다.');
    } finally {
      setBusy(null);
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
          {isOwner ? (
            <Card style={{ gap: spacing.lg }}>
              <Body style={{ fontWeight: '600', fontSize: fontSize.md }}>저장소 설정</Body>
              <Field label="저장소 이름">
                <Input
                  value={name}
                  onChangeText={setName}
                  placeholder="예: 동아리 사진첩"
                  maxLength={MAX_NAME_LENGTH}
                />
              </Field>
              <Field label="설명" hint={`선택 사항 · 최대 ${MAX_DESCRIPTION_LENGTH}자`}>
                <Input
                  value={description}
                  onChangeText={setDescription}
                  placeholder="어떤 파일을 모으는 곳인가요?"
                  maxLength={MAX_DESCRIPTION_LENGTH}
                  multiline
                  style={{ minHeight: 72, textAlignVertical: 'top' }}
                />
              </Field>
              <Button
                label="저장"
                icon="save-outline"
                onPress={() => void saveRepo()}
                loading={saving}
                disabled={!canSave}
              />
            </Card>
          ) : null}

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
                        loading={isBusy(member, 'role')}
                        onPress={() => void changeRole(member)}
                      />
                      <Button
                        label="소유자로 지정"
                        variant="secondary"
                        compact
                        loading={isBusy(member, 'transfer')}
                        onPress={() => void transferOwnership(member)}
                      />
                      <Button
                        label="내보내기"
                        variant="danger"
                        compact
                        loading={isBusy(member, 'remove')}
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
