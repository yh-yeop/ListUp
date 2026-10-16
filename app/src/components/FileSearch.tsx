import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatBytes, formatRelativeTime, parentPath, type SearchHit } from '@listup/shared';
import { ApiError, api } from '../api/client';
import { fontSize, monoFont, spacing, useTheme } from '../theme';
import { Body, Caption, Card, Divider, Input } from './ui';

/**
 * 파일 찾기 — 글자를 치면 잠시 뒤 서버에 묻고(이름·경로), 결과를 누르면 그 파일이 있는 폴더로 간다.
 * repoId 가 없으면 내 저장소 전부에서 찾고 저장소 이름을 함께 보인다. 1.4.0 서버부터.
 */
export function FileSearch({ repoId, placeholder }: { repoId?: string; placeholder?: string }) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    inflight.current?.abort();
    const q = query.trim();
    if (!q) {
      setHits(null);
      setError(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    inflight.current = controller;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.search(q, repoId, controller.signal);
        if (controller.signal.aborted) return;
        setHits(result.hits);
        setTruncated(result.truncated);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : '찾지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, repoId]);

  const open = (hit: SearchHit) => {
    setQuery('');
    router.push(`/repo/${hit.repoId}?path=${encodeURIComponent(parentPath(hit.path))}&highlight=${encodeURIComponent(hit.path)}`);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ position: 'relative', justifyContent: 'center' }}>
        <Ionicons name="search-outline" size={18} color={colors.textFaint} style={{ position: 'absolute', left: spacing.md, zIndex: 1 }} />
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder ?? '파일 이름으로 찾기'}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="파일 찾기"
          style={{ paddingLeft: spacing.xl + spacing.md }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="찾기 지우기"
            hitSlop={8}
            style={{ position: 'absolute', right: spacing.md }}
          >
            <Ionicons name="close-circle" size={18} color={colors.textFaint} />
          </Pressable>
        ) : null}
      </View>
      {query.trim() ? (
        <Card padded={false} style={{ paddingVertical: spacing.xs }}>
          {error ? (
            <Caption style={{ padding: spacing.md, color: colors.danger }}>{error}</Caption>
          ) : hits === null || (searching && hits.length === 0) ? (
            <Caption style={{ padding: spacing.md }}>찾는 중…</Caption>
          ) : hits.length === 0 ? (
            <Caption style={{ padding: spacing.md }}>맞는 파일이 없습니다.</Caption>
          ) : (
            <>
              {hits.map((hit, index) => (
                <View key={`${hit.repoId}:${hit.path}`}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    onPress={() => open(hit)}
                    accessibilityRole="button"
                    accessibilityLabel={`${hit.path} 열기`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                    })}
                  >
                    <Ionicons name="document-outline" size={18} color={colors.textMuted} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Body numberOfLines={1} style={{ fontWeight: hit.nameMatch ? '600' : '400' }}>
                        {hit.name}
                      </Body>
                      <Caption numberOfLines={1} style={{ fontFamily: monoFont, fontSize: fontSize.xs }}>
                        {repoId ? parentPath(hit.path) || '(맨 위)' : `${hit.repoName} / ${parentPath(hit.path)}`}
                      </Caption>
                    </View>
                    <Caption>
                      {formatBytes(hit.size)} · {formatRelativeTime(hit.updatedAt)}
                    </Caption>
                  </Pressable>
                </View>
              ))}
              {truncated ? <Caption style={{ padding: spacing.md }}>더 있습니다 — 글자를 더 넣어 좁혀 보세요.</Caption> : null}
            </>
          )}
        </Card>
      ) : null}
    </View>
  );
}
