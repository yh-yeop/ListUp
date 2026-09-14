import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, RefreshControl, Share, View } from 'react-native';
import {
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  formatInviteCode,
  formatRelativeTime,
  hasRole,
  type Invite,
  type RepoSummary,
  type Role,
} from '@listup/shared';
import {
  Badge,
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
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notify } from '../../../src/lib/dialogs';
import { inviteLinkFor, isLocalNetworkAddress } from '../../../src/lib/invite-link';
import { useAsync } from '../../../src/lib/useAsync';
import { useAuth } from '../../../src/state/auth';
import { serverUrl } from '../../../src/state/servers';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

const EXPIRY_OPTIONS = [
  { label: '무제한', days: null },
  { label: '1일', days: 1 },
  { label: '7일', days: 7 },
  { label: '30일', days: 30 },
];

const USE_OPTIONS = [
  { label: '무제한', uses: null },
  { label: '1회', uses: 1 },
  { label: '5회', uses: 5 },
  { label: '20회', uses: 20 },
];

export default function InvitesScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const { user, activeServer } = useAuth();
  const [role, setRole] = useState<Role>('viewer');
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync<{ repo: RepoSummary; invites: Invite[] }>(async () => {
    const { repo } = await api.getRepo(repoId);
    if (!hasRole(repo.role, 'editor')) return { repo, invites: [] };
    const { invites } = await api.listInvites(repoId);
    return { repo, invites };
  }, [repoId]);

  const repo = state.data?.repo;
  const canInvite = hasRole(repo?.role, 'editor');
  // 회수는 서버 규칙대로 발급자 본인 또는 소유자만.
  const canRevoke = (invite: Invite) => invite.createdBy === user?.id || repo?.role === 'owner';

  async function create() {
    setCreating(true);
    setError(null);
    try {
      await api.createInvite(repoId, { role, expiresInDays: expiryDays, maxUses });
      state.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '초대 코드를 만들지 못했습니다.');
    } finally {
      setCreating(false);
    }
  }

  // 초대 링크는 지금 이 서버에 들어온 주소로 만든다.
  const linkBase = activeServer ? serverUrl(activeServer) : '';
  const linkFor = (invite: Invite) => inviteLinkFor(linkBase, invite.code);
  const localOnly = isLocalNetworkAddress(inviteLinkFor(linkBase, 'code'));
  const LOCAL_WARNING =
    '이 링크의 주소는 같은 공유기(네트워크) 안에서만 열립니다. 밖에 있는 사람에게는 서버를 터널 주소나 고정 주소로 연 뒤 그 주소로 들어와 링크를 만드세요.';

  async function copy(invite: Invite) {
    await Clipboard.setStringAsync(formatInviteCode(invite.code));
    notify('초대 코드를 복사했습니다.', '받는 분에게 코드와 서버 주소를 함께 전달해 주세요.');
  }

  /** 링크 하나에 서버 주소와 코드가 함께 — 받는 사람은 누르기만 하면 된다. */
  async function copyLink(invite: Invite) {
    const link = linkFor(invite);
    await Clipboard.setStringAsync(link);
    notify('초대 링크를 복사했습니다.', localOnly ? LOCAL_WARNING : '받는 분이 링크를 누르면 가입·로그인 뒤 바로 참여합니다.');
  }

  async function shareLink(invite: Invite) {
    const link = linkFor(invite);
    if (localOnly) {
      const ok = await confirmAction({ title: '같은 네트워크에서만 열리는 링크입니다', message: LOCAL_WARNING, confirmLabel: '그래도 공유' });
      if (!ok) return;
    }
    await Share.share({ message: `ListUp 저장소 초대: ${link}` });
  }

  async function revoke(invite: Invite) {
    const ok = await confirmAction({
      title: '이 초대 코드를 회수할까요?',
      message: '이미 참여한 사람은 그대로 남고, 앞으로 이 코드로는 들어올 수 없습니다.',
      confirmLabel: '회수',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.revokeInvite(invite.id);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '회수하지 못했습니다.');
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
      <Stack.Screen options={{ title: '초대' }} />
      <Title>초대</Title>
      <RepoNav repoId={repoId} openProposals={repo?.openProposalCount} />

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : !canInvite ? (
        <Card>
          <EmptyState
            icon="lock-closed-outline"
            title="초대는 편집 권한부터"
            description="초대 코드는 편집 권한이 있는 멤버만 만들 수 있습니다."
          />
        </Card>
      ) : (
        <>
          <Card style={{ gap: spacing.lg }}>
            <View style={{ gap: spacing.xs }}>
              <Body style={{ fontWeight: '600' }}>새 초대 코드 만들기</Body>
              <Subtitle style={{ fontSize: fontSize.sm }}>
                링크를 받은 사람은 누르기만 하면 가입·로그인 뒤 저장소에 참여합니다. 코드만 전할 때는 서버
                주소도 함께 알려 주세요.
              </Subtitle>
            </View>

            <View style={{ gap: spacing.sm }}>
              <Caption>참여 권한</Caption>
              <Row gap={spacing.xs}>
                {(['viewer', 'editor'] as Role[]).map((value) => (
                  <Chip
                    key={value}
                    label={ROLE_LABEL[value]}
                    active={role === value}
                    onPress={() => setRole(value)}
                  />
                ))}
              </Row>
              <Caption>{ROLE_DESCRIPTION[role]}</Caption>
            </View>

            <View style={{ gap: spacing.sm }}>
              <Caption>유효 기간</Caption>
              <Row gap={spacing.xs} wrap>
                {EXPIRY_OPTIONS.map((option) => (
                  <Chip
                    key={option.label}
                    label={option.label}
                    active={expiryDays === option.days}
                    onPress={() => setExpiryDays(option.days)}
                  />
                ))}
              </Row>
            </View>

            <View style={{ gap: spacing.sm }}>
              <Caption>사용 가능 횟수</Caption>
              <Row gap={spacing.xs} wrap>
                {USE_OPTIONS.map((option) => (
                  <Chip
                    key={option.label}
                    label={option.label}
                    active={maxUses === option.uses}
                    onPress={() => setMaxUses(option.uses)}
                  />
                ))}
              </Row>
            </View>

            {error ? <ErrorNotice message={error} /> : null}

            <Button label="초대 코드 만들기" icon="key-outline" onPress={create} loading={creating} full />
          </Card>

          {state.data && state.data.invites.length > 0 ? (
            <Card padded={false} style={{ paddingVertical: spacing.sm }}>
              {state.data.invites.map((invite, index) => (
                <View key={invite.id}>
                  {index > 0 ? <Divider /> : null}
                  <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Body
                        style={{
                          fontFamily: monoFont,
                          fontSize: fontSize.lg,
                          letterSpacing: 1,
                          opacity: invite.active ? 1 : 0.5,
                        }}
                      >
                        {formatInviteCode(invite.code)}
                      </Body>
                      <Badge
                        label={invite.active ? '사용 가능' : '사용 불가'}
                        tone={invite.active ? 'success' : 'neutral'}
                      />
                    </Row>

                    <Row gap={spacing.md} wrap>
                      <Caption>{ROLE_LABEL[invite.role]} 권한</Caption>
                      <Caption>
                        {invite.maxUses === null
                          ? `${invite.useCount}명 참여`
                          : `${invite.useCount}/${invite.maxUses}명 참여`}
                      </Caption>
                      <Caption>
                        {invite.revokedAt !== null
                          ? '회수됨'
                          : invite.expiresAt === null
                            ? '기한 없음'
                            : invite.expiresAt <= Date.now()
                              ? '만료됨'
                              : `${new Date(invite.expiresAt).toLocaleDateString('ko-KR')}까지`}
                      </Caption>
                      <Caption>{formatRelativeTime(invite.createdAt)} 생성</Caption>
                    </Row>

                    {invite.active ? (
                      <Caption numberOfLines={1} style={{ fontFamily: monoFont }}>
                        {linkFor(invite)}
                      </Caption>
                    ) : null}

                    <Row gap={spacing.sm} wrap>
                      {invite.active ? (
                        <Button
                          label="링크 복사"
                          icon="link-outline"
                          compact
                          onPress={() => void copyLink(invite)}
                        />
                      ) : null}
                      {invite.active && Platform.OS !== 'web' ? (
                        <Button
                          label="공유"
                          icon="share-social-outline"
                          variant="secondary"
                          compact
                          onPress={() => void shareLink(invite)}
                        />
                      ) : null}
                      <Button
                        label="코드 복사"
                        icon="copy-outline"
                        variant="secondary"
                        compact
                        onPress={() => void copy(invite)}
                      />
                      {invite.revokedAt === null && canRevoke(invite) ? (
                        <Button
                          label="회수"
                          variant="ghost"
                          compact
                          onPress={() => void revoke(invite)}
                        />
                      ) : null}
                    </Row>
                  </View>
                </View>
              ))}
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon="key-outline"
                title="아직 만든 초대가 없습니다"
                description="초대 코드를 만들어 전달하면, 받은 사람이 코드를 입력해 이 저장소에 참여할 수 있습니다."
              />
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm - 2,
        borderRadius: radius.pill,
        backgroundColor: active ? colors.accentSoft : colors.surfaceAlt,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Body
        style={{
          color: active ? colors.accent : colors.textMuted,
          fontSize: fontSize.sm,
          fontWeight: active ? '700' : '500',
        }}
      >
        {label}
      </Body>
    </Pressable>
  );
}
