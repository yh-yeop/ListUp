import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { RefreshControl, View } from 'react-native';
import { formatRelativeTime, type RepoEvent } from '@listup/shared';
import {
  Body,
  Caption,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  LoadMoreFooter,
  Loading,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { ApiError, api } from '../../../src/api/client';
import { describeEvent } from '../../../src/lib/pure/events';
import { useAsync } from '../../../src/lib/useAsync';
import { useMorePages, type Page } from '../../../src/lib/useMorePages';
import { spacing, useTheme } from '../../../src/theme';

type Cursor = { before: number };

/** 활동 기록 — 멤버 참여·내보내기·역할 변경, 초대 발급·회수. 소유자만 본다(서버가 판정). */
export default function ActivityScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();

  const state = useAsync<Page<RepoEvent, Cursor>>(async () => {
    try {
      const { events, next } = await api.repoEvents(repoId);
      return { items: events, next };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('이 서버에는 아직 이 기능이 없습니다. 서버 주인에게 ListUp 서버를 1.8 이상으로 업데이트해 달라고 부탁하세요.');
      }
      throw err;
    }
  }, [repoId]);

  const pages = useMorePages(state.data, async (cursor: Cursor) => {
    const { events, next } = await api.repoEvents(repoId, cursor.before);
    return { items: events, next };
  });

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />
      }
    >
      <Stack.Screen options={{ title: '활동 기록' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>활동 기록</Title>
        <Subtitle>
          누가 언제 들어오고 나갔는지, 권한과 초대가 어떻게 바뀌었는지 남습니다. 파일 변경은 변경 이력에서 봅니다.
        </Subtitle>
      </View>

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : pages.items.length > 0 ? (
        <Card padded={false} style={{ paddingVertical: spacing.sm }}>
          {pages.items.map((event, index) => {
            const line = describeEvent(event);
            return (
              <View key={event.seq}>
                {index > 0 ? <Divider /> : null}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                  }}
                >
                  <Ionicons name={line.icon} size={18} color={colors.textMuted} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Body>{line.text}</Body>
                    <Caption>{formatRelativeTime(event.createdAt)}</Caption>
                  </View>
                </View>
              </View>
            );
          })}
          {pages.next ? (
            <LoadMoreFooter onPress={pages.loadMore} loading={pages.loadingMore} disabled={state.refreshing} />
          ) : null}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon="pulse-outline"
            title="아직 기록이 없습니다"
            description="서버를 1.8 로 올린 뒤의 참여·내보내기·권한 변경·초대가 여기에 쌓입니다."
          />
        </Card>
      )}
    </Screen>
  );
}
