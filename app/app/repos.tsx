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
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Loading,
  Row,
  Screen,
  Title,
} from '../src/components/ui';
import { ApiError, api } from '../src/api/client';
import { REPO_SEARCH_MIN, searchRepos } from '../src/lib/search';
import { useAsync } from '../src/lib/useAsync';
import { useAuth } from '../src/state/auth';
import { fontSize, spacing, useTheme } from '../src/theme';

export default function ReposScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const state = useAsync(async () => (await api.listRepos()).repos, []);
  const repos = state.data ?? [];
  const searchable = repos.length >= REPO_SEARCH_MIN;
  const shown = searchable ? searchRepos(repos, query) : repos;

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
              accessibilityRole="button"
              accessibilityLabel="내 정보"
              hitSlop={12}
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
      </Row>

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
      ) : repos.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          {searchable ? (
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="저장소 이름이나 설명으로 찾기"
              accessibilityLabel="저장소 찾기"
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
            />
          ) : null}
          {shown.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
          {shown.length === 0 ? (
            <Card>
              <EmptyState
                icon="search-outline"
                title="찾는 저장소가 없습니다"
                description="저장소 이름이나 설명에 들어간 낱말로 찾아 보세요. 띄어 쓴 낱말은 모두 들어 있어야 합니다."
              />
            </Card>
          ) : null}
        </View>
      ) : (
        <Card>
          <EmptyState
            icon="folder-outline"
            title="아직 저장소가 없습니다"
            description="새 저장소를 만들거나, 받은 초대 코드로 다른 사람의 저장소에 참여해 보세요."
          />
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
          <Badge
            label={ROLE_LABEL[repo.role]}
            tone={repo.role === 'owner' ? 'accent' : 'neutral'}
          />
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
