import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, View } from 'react-native';
import {
  ROLE_LABEL,
  formatBytes,
  formatRelativeTime,
  hasRole,
  type RepoSummary,
  type TreeListing,
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
  IconButton,
  Loading,
  Row,
  Screen,
  Title,
} from '../../../src/components/ui';
import { Breadcrumb, RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notify } from '../../../src/lib/dialogs';
import { downloadFile, pickFiles } from '../../../src/lib/files';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, spacing, useTheme } from '../../../src/theme';

interface RepoView {
  repo: RepoSummary;
  tree: TreeListing;
}

export default function RepoFilesScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [path, setPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const state = useAsync<RepoView>(async () => {
    const [{ repo }, { tree }] = await Promise.all([
      api.getRepo(repoId),
      api.listFiles(repoId, path),
    ]);
    return { repo, tree };
  }, [repoId, path]);

  useFocusEffect(
    useCallback(() => {
      state.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repoId, path]),
  );

  const repo = state.data?.repo;
  const tree = state.data?.tree;
  const canEdit = hasRole(repo?.role, 'editor');

  async function upload() {
    if (uploading) return;
    let sources;
    try {
      sources = await pickFiles(true);
    } catch {
      notify('파일을 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;

    setUploading(true);
    let done = 0;
    let failed = 0;
    for (const source of sources) {
      const target = path ? `${path}/${source.name}` : source.name;
      try {
        await api.uploadFile(repoId, target, source);
        done += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof ApiError && err.code === 'forbidden') break;
      }
    }
    setUploading(false);
    state.refresh();

    if (failed > 0) notify(`${done}개 올렸습니다.`, `${failed}개는 올리지 못했습니다.`);
  }

  async function download(filePath: string, fileName: string) {
    setBusyPath(filePath);
    try {
      const result = await downloadFile(api.fileUrl(repoId, filePath), fileName);
      if (result.message) notify(result.message);
    } catch {
      notify('내려받지 못했습니다.');
    } finally {
      setBusyPath(null);
    }
  }

  async function remove(targetPath: string, isFolder: boolean) {
    const ok = await confirmAction({
      title: isFolder ? '이 폴더를 지울까요?' : '이 파일을 지울까요?',
      message: isFolder
        ? `${targetPath} 아래의 파일이 모두 사라집니다. 변경 이력에는 남습니다.`
        : `${targetPath} 이(가) 목록에서 사라집니다. 변경 이력에는 남습니다.`,
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;

    setBusyPath(targetPath);
    try {
      await api.deletePath(repoId, targetPath);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '삭제하지 못했습니다.');
    } finally {
      setBusyPath(null);
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
      <Stack.Screen options={{ title: repo?.name ?? '저장소' }} />

      {state.loading && !repo ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : repo && tree ? (
        <>
          <View style={{ gap: spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Title style={{ flex: 1 }}>{repo.name}</Title>
              <Badge label={ROLE_LABEL[repo.role]} tone={repo.role === 'owner' ? 'accent' : 'neutral'} />
            </Row>
            {repo.description ? <Body muted>{repo.description}</Body> : null}
            <Row gap={spacing.md} wrap>
              <Caption>파일 {repo.fileCount}개</Caption>
              <Caption>{formatBytes(repo.totalSize)}</Caption>
              <Caption>멤버 {repo.memberCount}명</Caption>
            </Row>
          </View>

          <RepoNav repoId={repoId} openProposals={repo.openProposalCount} />

          <Row gap={spacing.sm} wrap>
            {canEdit ? (
              <Button
                label="파일 올리기"
                icon="cloud-upload-outline"
                onPress={upload}
                loading={uploading}
              />
            ) : null}
            <Button
              label="변경 제안하기"
              icon="git-pull-request-outline"
              variant={canEdit ? 'secondary' : 'primary'}
              onPress={() =>
                router.push(`/repo/${repoId}/new-proposal?path=${encodeURIComponent(path)}`)
              }
            />
          </Row>

          {!canEdit ? (
            <Caption>
              열람 권한이라 파일을 직접 바꿀 수는 없지만, 변경 제안을 올리면 편집자가 검토 후
              반영합니다.
            </Caption>
          ) : null}

          <Breadcrumb path={path} onNavigate={setPath} />

          <Card padded={false}>
            {tree.dirs.length === 0 && tree.files.length === 0 ? (
              <EmptyState
                icon="folder-open-outline"
                title={path === '' ? '아직 파일이 없습니다' : '빈 폴더입니다'}
                description={
                  canEdit
                    ? '파일을 올리면 여기에 표시됩니다.'
                    : '편집 권한이 있는 멤버가 파일을 올리면 여기에 표시됩니다.'
                }
              />
            ) : (
              <>
                {tree.dirs.map((dir, index) => (
                  <View key={dir.path}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => setPath(dir.path)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: spacing.md,
                        paddingVertical: spacing.md,
                        paddingHorizontal: spacing.lg,
                        backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                      })}
                    >
                      <Ionicons name="folder" size={20} color={colors.accent} />
                      <View style={{ flex: 1 }}>
                        <Body numberOfLines={1} style={{ fontWeight: '500' }}>
                          {dir.name}
                        </Body>
                        <Caption>
                          파일 {dir.fileCount}개 · {formatBytes(dir.totalSize)}
                        </Caption>
                      </View>
                      {canEdit ? (
                        <IconButton
                          icon="trash-outline"
                          label={`${dir.name} 폴더 삭제`}
                          tone="danger"
                          onPress={() => void remove(dir.path, true)}
                        />
                      ) : null}
                      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                    </Pressable>
                  </View>
                ))}

                {tree.files.map((file, index) => (
                  <View key={file.path}>
                    {index > 0 || tree.dirs.length > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => void download(file.path, file.name)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: spacing.md,
                        paddingVertical: spacing.md,
                        paddingHorizontal: spacing.lg,
                        backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                      })}
                    >
                      <Ionicons
                        name={iconForMime(file.mimeType)}
                        size={20}
                        color={colors.textMuted}
                      />
                      <View style={{ flex: 1 }}>
                        <Body numberOfLines={1} style={{ fontSize: fontSize.md }}>
                          {file.name}
                        </Body>
                        <Caption>
                          {formatBytes(file.size)} · {formatRelativeTime(file.updatedAt)}
                        </Caption>
                      </View>
                      {busyPath === file.path ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                      ) : (
                        <>
                          <IconButton
                            icon="download-outline"
                            label={`${file.name} 내려받기`}
                            onPress={() => void download(file.path, file.name)}
                          />
                          {canEdit ? (
                            <IconButton
                              icon="trash-outline"
                              label={`${file.name} 삭제`}
                              tone="danger"
                              onPress={() => void remove(file.path, false)}
                            />
                          ) : null}
                        </>
                      )}
                    </Pressable>
                  </View>
                ))}
              </>
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function iconForMime(mimeType: string): 'image-outline' | 'musical-notes-outline' | 'videocam-outline' | 'document-text-outline' | 'archive-outline' | 'document-outline' {
  if (mimeType.startsWith('image/')) return 'image-outline';
  if (mimeType.startsWith('audio/')) return 'musical-notes-outline';
  if (mimeType.startsWith('video/')) return 'videocam-outline';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'document-text-outline';
  if (mimeType === 'application/zip' || mimeType === 'application/gzip') return 'archive-outline';
  return 'document-outline';
}
