import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { ROLE_LABEL, formatBytes, formatRelativeTime, type RepoSummary } from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  ErrorNotice,
  Field,
  Input,
  Loading,
  Row,
  Screen,
  Title,
} from '../src/components/ui';
import { ApiError, api } from '../src/api/client';
import { FileSearch } from '../src/components/FileSearch';
import { useUnreadActivity } from '../src/lib/activity';
import { notifySuccess } from '../src/lib/dialogs';
import { useAsync } from '../src/lib/useAsync';
import { LEVEL_1_4, LEVEL_1_5, useServerLevel } from '../src/lib/useServerLevel';
import { useAuth } from '../src/state/auth';
import { fontSize, radius, spacing, useTheme } from '../src/theme';

export default function ReposScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 다른 서버의 저장소 따라가기 (1.4.0 서버부터). */
  const serverLevel = useServerLevel();
  const { activeServer } = useAuth();
  // 목록으로 돌아올 때마다 읽지 않은 소식을 다시 센다.
  const [focusCount, setFocusCount] = useState(0);
  const unread = useUnreadActivity(activeServer?.id ?? 'default', focusCount);
  const [following, setFollowing] = useState(false);
  const [mirrorLink, setMirrorLink] = useState('');
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);

  const follow = async () => {
    if (mirrorBusy) return;
    setMirrorError(null);
    setMirrorBusy(true);
    try {
      const { repo } = await api.createMirror(mirrorLink.trim());
      setMirrorLink('');
      setFollowing(false);
      notifySuccess('따라가기 시작했습니다.', '원본의 파일을 가져오는 중입니다. 큰 저장소는 시간이 걸립니다.');
      router.push(`/repo/${repo.id}`);
    } catch (err) {
      setMirrorError(err instanceof ApiError ? err.message : '따라가지 못했습니다.');
    } finally {
      setMirrorBusy(false);
    }
  };

  const state = useAsync(async () => (await api.listRepos()).repos, []);

  // 다른 화면에서 저장소를 만들거나 나간 뒤 돌아오면 목록을 갱신한다.
  // 처음 포커스는 useAsync 의 첫 요청과 겹치므로 건너뛴다.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      state.refresh();
      setFocusCount((n) => n + 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const submit = async () => {
    if (busy) return;
    setFormError(null);
    if (!name.trim()) {
      setFormError('저장소 이름을 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const { repo } = await api.createRepo({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setName('');
      setDescription('');
      setCreating(false);
      router.push(`/repo/${repo.id}`);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '저장소를 만들지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

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
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/settings')}
              accessibilityLabel="내 정보"
              hitSlop={8}
              style={{ paddingHorizontal: spacing.md }}
            >
              <Ionicons name="person-circle-outline" size={24} color={colors.textMuted} />
            </Pressable>
          ),
        }}
      />

      <View style={{ gap: spacing.xs }}>
        <Title>내 저장소</Title>
        <Caption>{user ? `${user.displayName} 님으로 로그인됨` : ''}</Caption>
      </View>

      {serverLevel >= LEVEL_1_5 ? (
        <>
          <FileSearch placeholder="내 저장소 전부에서 파일 찾기" />
          <Pressable
            onPress={() => router.push('/activity')}
            accessibilityRole="button"
            accessibilityLabel={unread ? `새 소식 ${unread}개` : '새 소식'}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: unread ? colors.accent : colors.border,
              backgroundColor: pressed ? colors.surfaceAlt : unread ? colors.accentSoft : colors.surface,
            })}
          >
            <Ionicons name={unread ? 'notifications' : 'notifications-outline'} size={20} color={unread ? colors.accent : colors.textMuted} />
            <Body style={{ flex: 1, fontWeight: unread ? '600' : '400' }}>
              {unread ? `새 소식 ${unread}개` : '새 소식'}
            </Body>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </Pressable>
        </>
      ) : null}

      <Row gap={spacing.sm} wrap>
        <Button
          label="새 저장소"
          icon="add"
          onPress={() => setCreating((prev) => !prev)}
          variant={creating ? 'secondary' : 'primary'}
        />
        <Button
          label="초대 코드로 참여"
          icon="key-outline"
          variant="secondary"
          onPress={() => router.push('/join')}
        />
        {serverLevel >= LEVEL_1_4 ? (
          <Button
            label="다른 서버 저장소 따라가기"
            icon="git-network-outline"
            variant="secondary"
            onPress={() => setFollowing((prev) => !prev)}
          />
        ) : null}
      </Row>

      {following ? (
        <Card style={{ gap: spacing.lg }}>
          <Body muted>
            다른 ListUp 서버의 소유자에게 받은 따라가기 링크를 넣으면, 그 저장소를 이 서버에 읽기 전용 사본으로 두고
            바뀐 것만 주기적으로 가져옵니다. 원본 서버가 꺼져 있어도 사본은 볼 수 있습니다.
          </Body>
          <Field label="따라가기 링크" hint="예: https://원본서버/s/…">
            <Input value={mirrorLink} onChangeText={setMirrorLink} autoCapitalize="none" autoCorrect={false} inputMode="url" placeholder="https://" />
          </Field>
          {mirrorError ? <ErrorNotice message={mirrorError} /> : null}
          <Row gap={spacing.sm}>
            <Button label="따라가기" onPress={() => void follow()} loading={mirrorBusy} disabled={!mirrorLink.trim()} />
            <Button label="취소" variant="ghost" onPress={() => setFollowing(false)} />
          </Row>
        </Card>
      ) : null}

      {creating ? (
        <Card style={{ gap: spacing.lg }}>
          <Field label="저장소 이름">
            <Input value={name} onChangeText={setName} placeholder="예: 동아리 사진첩" />
          </Field>
          <Field label="설명" hint="선택 사항">
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder="어떤 파일을 모으는 곳인가요?"
              multiline
              style={{ minHeight: 72, textAlignVertical: 'top' }}
            />
          </Field>
          {formError ? <ErrorNotice message={formError} /> : null}
          <Row gap={spacing.sm}>
            <Button label="만들기" onPress={submit} loading={busy} />
            <Button label="취소" variant="ghost" onPress={() => setCreating(false)} />
          </Row>
        </Card>
      ) : null}

      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data && state.data.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          {state.data.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </View>
      ) : (
        <Card style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: radius.pill,
              backgroundColor: colors.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="folder-outline" size={26} color={colors.textFaint} />
          </View>
          <Body style={{ fontWeight: '600' }}>아직 저장소가 없습니다</Body>
          <Body muted style={{ textAlign: 'center' }}>
            새 저장소를 만들거나, 받은 초대 코드로 다른 사람의 저장소에 참여해 보세요.
          </Body>
        </Card>
      )}
    </Screen>
  );
}

function RepoCard({ repo }: { repo: RepoSummary }) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => router.push(`/repo/${repo.id}`)}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ gap: spacing.sm }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={spacing.sm} style={{ flex: 1 }}>
            <Ionicons name="folder" size={20} color={colors.accent} />
            <Body numberOfLines={1} style={{ fontWeight: '600', flex: 1, fontSize: fontSize.lg }}>
              {repo.name}
            </Body>
          </Row>
          <Row gap={spacing.xs}>
            {repo.mirror ? <Badge label="따라가는 중" icon="git-network-outline" tone="neutral" /> : null}
            <Badge
              label={ROLE_LABEL[repo.role]}
              tone={repo.role === 'owner' ? 'accent' : 'neutral'}
            />
          </Row>
        </Row>

        {repo.description ? (
          <Body muted numberOfLines={2}>
            {repo.description}
          </Body>
        ) : null}

        <Row gap={spacing.md} wrap>
          <Caption>파일 {repo.fileCount}개</Caption>
          <Caption>{formatBytes(repo.totalSize)}</Caption>
          <Caption>멤버 {repo.memberCount}명</Caption>
          <Caption>{formatRelativeTime(repo.updatedAt)} 업데이트</Caption>
        </Row>

        {repo.openProposalCount > 0 ? (
          <Badge
            label={`검토 대기 중인 제안 ${repo.openProposalCount}건`}
            tone="warning"
            icon="git-pull-request-outline"
          />
        ) : null}
      </Card>
    </Pressable>
  );
}
