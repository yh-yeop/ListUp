import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { formatBytes, formatRelativeTime } from '@listup/shared';
import { ApiError } from '../api/client';
import { listRepoFolder, type RepoFile } from '../lib/folder-compare';
import { MAX_SEARCH_RESULTS, searchFiles } from '../lib/search';
import { fontSize, spacing, useTheme } from '../theme';
import { Caption, Card, Divider, EmptyState, ErrorNotice, IconButton, Loading } from './ui';

/**
 * 저장소 전체의 파일 목록을 한 번 받아 두고 그 안에서 찾는다. 목록은 시점(head 또는 과거 시점)마다
 * 한 번만 받는다 — 파일이 바뀌면 head 가 바뀌어 다시 받는다.
 */
function useRepoFiles(repoId: string, snapshotId: string | undefined, headId: string | null, enabled: boolean) {
  const [files, setFiles] = useState<RepoFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${repoId}:${snapshotId ?? `head:${headId ?? ''}`}`;

  useEffect(() => {
    if (!enabled || loadedFor.current === key) return;
    loadedFor.current = key;
    let alive = true;
    let done = false;
    setFiles(null);
    setError(null);
    listRepoFolder(repoId, '', snapshotId)
      .then((list) => {
        done = true;
        if (alive) setFiles(list);
      })
      .catch((err) => {
        done = true;
        if (!alive) return;
        loadedFor.current = null;
        setError(err instanceof ApiError ? err.message : '파일 목록을 불러오지 못했습니다.');
      });
    return () => {
      alive = false;
      // 받는 도중에 그만두면(검색어를 지움·시점이 바뀜) 다음에 다시 받는다.
      if (!done) loadedFor.current = null;
    };
  }, [repoId, key, snapshotId, enabled, attempt]);

  return { files, error, retry: () => setAttempt((n) => n + 1) };
}

/** 검색 결과. 누르면 받고, 폴더 아이콘은 그 파일이 있는 폴더를 연다. */
export function SearchResults({
  repoId,
  query,
  snapshotId,
  headId,
  busyPath,
  onDownload,
  onOpenFolder,
  onVersions,
}: {
  repoId: string;
  query: string;
  /** 과거 시점을 보고 있으면 그 시점에서 찾는다. */
  snapshotId?: string;
  /** 지금 시점. 바뀌면(파일을 올리거나 지움) 목록을 다시 받는다. */
  headId: string | null;
  busyPath: string | null;
  onDownload: (path: string, name: string) => void;
  onOpenFolder: (folderPath: string) => void;
  /** 없으면 버전 버튼을 숨긴다(과거 시점 보기). */
  onVersions?: (path: string) => void;
}) {
  const { colors } = useTheme();
  const { files, error, retry } = useRepoFiles(repoId, snapshotId, headId, query.trim().length > 0);
  const results = useMemo(() => (files ? searchFiles(files, query) : []), [files, query]);

  if (error) return <ErrorNotice message={error} onRetry={retry} />;
  if (!files) return <Loading label="저장소 전체에서 찾는 중…" />;

  const shown = results.slice(0, MAX_SEARCH_RESULTS);
  return (
    <View style={{ gap: spacing.sm }}>
      <Caption>
        {results.length === 0
          ? `파일 ${files.length}개 중 찾은 것이 없습니다.`
          : results.length > shown.length
            ? `${results.length}개 중 ${shown.length}개를 보여 줍니다 — 낱말을 더 넣어 좁혀 보세요.`
            : `${results.length}개 찾음`}
      </Caption>
      {shown.length === 0 ? (
        <Card>
          <EmptyState icon="search-outline" title="찾은 파일이 없습니다" description="띄어 쓴 낱말이 모두 들어간 경로를 찾습니다." />
        </Card>
      ) : (
        <Card padded={false}>
          {shown.map((file, index) => {
            const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
            return (
              <View key={file.path}>
                {index > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() => onDownload(file.path, file.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`${file.name} 내려받기`}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingVertical: spacing.md,
                    paddingHorizontal: spacing.lg,
                    backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                  })}
                >
                  <Ionicons name="document-outline" size={20} color={colors.textMuted} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.text, fontSize: fontSize.md }}>
                      {file.name}
                    </Text>
                    <Caption numberOfLines={1}>{folder || '맨 위'}</Caption>
                    <Caption>
                      {formatBytes(file.size)} · {formatRelativeTime(file.updatedAt)}
                    </Caption>
                  </View>
                  {busyPath === file.path ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    <>
                      <IconButton
                        icon="folder-open-outline"
                        label={`${file.name} 이(가) 있는 폴더 열기`}
                        onPress={() => onOpenFolder(folder)}
                      />
                      {onVersions ? (
                        <IconButton icon="time-outline" label={`${file.name} 버전`} onPress={() => onVersions(file.path)} />
                      ) : null}
                      <IconButton
                        icon="download-outline"
                        label={`${file.name} 내려받기`}
                        onPress={() => onDownload(file.path, file.name)}
                      />
                    </>
                  )}
                </Pressable>
              </View>
            );
          })}
        </Card>
      )}
    </View>
  );
}
