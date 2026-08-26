import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import {
  ROLE_LABEL,
  formatBytes,
  formatRelativeTime,
  hasRole,
  normalizePath,
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
  Input,
  Loading,
  Row,
  Screen,
  Title,
} from '../../../src/components/ui';
import { Breadcrumb, RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api, getMaxUploadBytes, type UploadSource } from '../../../src/api/client';
import { confirmAction, notify } from '../../../src/lib/dialogs';
import { downloadFile, pickFiles } from '../../../src/lib/files';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

interface RepoView {
  repo: RepoSummary;
  tree: TreeListing;
}

/** 인라인으로 이름을 바꾸는 중인 항목. 한 번에 하나만 편집한다. */
interface Editing {
  path: string;
  isFolder: boolean;
  value: string;
}

/** 업로드 실패 안내에 나열할 최대 건수. 나머지는 'n건 더' 로 줄인다. */
const MAX_FAILURES_SHOWN = 3;

export default function RepoFilesScreen() {
  const {
    repoId,
    snapshot,
    message: snapshotMessage,
    at: snapshotAt,
  } = useLocalSearchParams<{ repoId: string; snapshot?: string; message?: string; at?: string }>();
  const { colors } = useTheme();
  const [path, setPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState(false);

  // 변경 이력에서 넘어온 과거 시점. 있으면 그 시점의 목록을 읽기 전용으로 보여준다.
  // 폴더 이동은 path 상태만 바꾸므로 snapshot 파라미터는 그대로 유지된다.
  const snapshotId = snapshot || undefined;

  const state = useAsync<RepoView>(async () => {
    const [{ repo }, { tree }] = await Promise.all([
      api.getRepo(repoId),
      api.listFiles(repoId, path, snapshotId),
    ]);
    return { repo, tree };
  }, [repoId, path, snapshotId]);

  // 다른 화면에 다녀오면 목록을 갱신한다. 처음 포커스는 useAsync 의 첫 요청과 겹치므로
  // 건너뛰고, 폴더 이동은 useAsync 의 deps 가 처리하므로 여기서 다시 부르지 않는다.
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

  const repo = state.data?.repo;
  const tree = state.data?.tree;
  const isEditor = hasRole(repo?.role, 'editor');
  // 과거 시점에서는 편집 권한이 있어도 바꿀 수 없다.
  const canEdit = isEditor && !snapshotId;

  function openFolder(nextPath: string) {
    setEditing(null);
    setPath(nextPath);
  }

  /** snapshot 파라미터를 지워 현재 시점으로 돌아간다. 보고 있던 폴더는 유지된다. */
  function backToPresent() {
    router.setParams({ snapshot: undefined, message: undefined, at: undefined });
  }

  async function upload() {
    if (uploading) return;
    let sources: UploadSource[];
    try {
      sources = await pickFiles(true);
    } catch {
      notify('파일을 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;

    // 서버가 거부할 크기는 올리지 않고 바로 안내한다. 한도는 서버 설정을 따른다.
    const maxBytes = await getMaxUploadBytes();
    const tooLarge = sources.filter((source) => source.size > maxBytes);
    if (tooLarge.length > 0) {
      notify(
        `${tooLarge.map((source) => source.name).join(', ')} 은(는) ${formatBytes(
          maxBytes,
        )} 를 넘어 올릴 수 없습니다.`,
      );
    }
    const accepted = sources.filter((source) => source.size <= maxBytes);
    if (accepted.length === 0) return;

    // 현재 폴더에 같은 이름이 있으면 올리기 전에 한 번에 묻는다. 취소하면 아무것도 올리지 않는다.
    const existing = new Set((tree?.files ?? []).map((file) => file.name));
    const overwrites = accepted.filter((source) => existing.has(source.name));
    if (overwrites.length > 0) {
      const ok = await confirmAction({
        title: '같은 이름의 파일이 있습니다. 덮어쓸까요?',
        message: `${overwrites.map((source) => source.name).join(', ')}\n\n이전 버전은 변경 이력에 남아 언제든 다시 볼 수 있습니다.`,
        confirmLabel: '덮어쓰기',
      });
      if (!ok) return;
    }

    setUploading(true);
    let done = 0;
    const failures: string[] = [];
    for (const [index, source] of accepted.entries()) {
      const target = path ? `${path}/${source.name}` : source.name;
      try {
        await api.uploadFile(repoId, target, source);
        done += 1;
      } catch (err) {
        failures.push(
          `${source.name}: ${err instanceof ApiError ? err.message : '올리지 못했습니다.'}`,
        );
        // 권한이 없으면 나머지도 같은 이유로 실패하므로 여기서 멈춘다.
        if (err instanceof ApiError && err.code === 'forbidden') {
          for (const rest of accepted.slice(index + 1)) failures.push(`${rest.name}: 권한 없음`);
          break;
        }
      }
    }
    setUploading(false);
    state.refresh();

    if (failures.length > 0) {
      const shown = failures.slice(0, MAX_FAILURES_SHOWN);
      const more = failures.length - shown.length;
      notify(
        `${done}개 올렸습니다.`,
        `${failures.length}개는 올리지 못했습니다.\n${shown.join('\n')}${
          more > 0 ? `\n외 ${more}건 더` : ''
        }`,
      );
    }
  }

  async function download(filePath: string, fileName: string) {
    setBusyPath(filePath);
    try {
      const result = await downloadFile(api.fileUrl(repoId, filePath, { snapshotId }), fileName);
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

  function startRename(targetPath: string, isFolder: boolean) {
    setEditing({ path: targetPath, isFolder, value: targetPath });
  }

  async function confirmRename() {
    if (!editing || renaming) return;
    const to = normalizePath(editing.value);
    if (!to) {
      notify('경로가 올바르지 않습니다.', '빈 이름이나 . / .. 은 쓸 수 없습니다.');
      return;
    }
    if (to === editing.path) {
      setEditing(null);
      return;
    }
    setRenaming(true);
    try {
      await api.movePath(repoId, editing.path, to);
      setEditing(null);
      state.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '이름을 바꾸지 못했습니다.');
    } finally {
      setRenaming(false);
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

          {snapshotId ? (
            <View
              style={{
                backgroundColor: colors.warningSoft,
                borderRadius: radius.md,
                padding: spacing.md,
                gap: spacing.md,
              }}
            >
              <Row gap={spacing.sm} style={{ alignItems: 'flex-start' }}>
                <Ionicons
                  name="time-outline"
                  size={18}
                  color={colors.warning}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Body style={{ fontWeight: '600', color: colors.warning }}>과거 시점 보기</Body>
                  <Caption>{describeSnapshot(snapshotId, snapshotMessage, snapshotAt)}</Caption>
                  <Caption>이 시점의 파일은 내려받기만 할 수 있습니다.</Caption>
                </View>
              </Row>
              <Button
                label="현재로 돌아가기"
                icon="arrow-undo-outline"
                variant="secondary"
                compact
                onPress={backToPresent}
              />
            </View>
          ) : (
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
          )}

          {!isEditor && !snapshotId ? (
            <Caption>
              열람 권한이라 파일을 직접 바꿀 수는 없지만, 변경 제안을 올리면 편집자가 검토 후
              반영합니다.
            </Caption>
          ) : null}

          <Breadcrumb path={path} onNavigate={openFolder} />

          {state.loading ? (
            // 폴더를 옮기는 동안 이전 폴더 목록이 새 브레드크럼 아래 남지 않게 한다.
            <Loading label="목록 불러오는 중…" />
          ) : (
            <Card padded={false}>
              {tree.dirs.length === 0 && tree.files.length === 0 ? (
                <EmptyState
                  icon="folder-open-outline"
                  title={
                    path !== ''
                      ? '빈 폴더입니다'
                      : snapshotId
                        ? '이 시점에는 파일이 없습니다'
                        : '아직 파일이 없습니다'
                  }
                  description={
                    snapshotId
                      ? undefined
                      : canEdit
                        ? '파일을 올리면 여기에 표시됩니다.'
                        : '편집 권한이 있는 멤버가 파일을 올리면 여기에 표시됩니다.'
                  }
                />
              ) : (
                <>
                  {tree.dirs.map((dir, index) => (
                    <View key={dir.path}>
                      {index > 0 ? <Divider /> : null}
                      {editing?.path === dir.path ? (
                        <RenameRow
                          icon="folder"
                          value={editing.value}
                          busy={renaming}
                          hint="폴더 경로를 바꾸면 안의 파일이 모두 함께 옮겨집니다."
                          onChange={(value) => setEditing({ ...editing, value })}
                          onConfirm={() => void confirmRename()}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <Pressable
                          onPress={() => openFolder(dir.path)}
                          accessibilityRole="button"
                          accessibilityLabel={`${dir.name} 폴더 열기`}
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
                            <Text
                              numberOfLines={1}
                              ellipsizeMode="middle"
                              style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '500' }}
                            >
                              {dir.name}
                            </Text>
                            <Caption>
                              파일 {dir.fileCount}개 · {formatBytes(dir.totalSize)}
                            </Caption>
                          </View>
                          {canEdit ? (
                            <>
                              <IconButton
                                icon="create-outline"
                                label={`${dir.name} 폴더 이름 변경`}
                                onPress={() => startRename(dir.path, true)}
                              />
                              <IconButton
                                icon="trash-outline"
                                label={`${dir.name} 폴더 삭제`}
                                tone="danger"
                                onPress={() => void remove(dir.path, true)}
                              />
                            </>
                          ) : null}
                          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                        </Pressable>
                      )}
                    </View>
                  ))}

                  {tree.files.map((file, index) => (
                    <View key={file.path}>
                      {index > 0 || tree.dirs.length > 0 ? <Divider /> : null}
                      {editing?.path === file.path ? (
                        <RenameRow
                          icon={iconForMime(file.mimeType)}
                          value={editing.value}
                          busy={renaming}
                          onChange={(value) => setEditing({ ...editing, value })}
                          onConfirm={() => void confirmRename()}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <Pressable
                          onPress={() => void download(file.path, file.name)}
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
                          <Ionicons
                            name={iconForMime(file.mimeType)}
                            size={20}
                            color={colors.textMuted}
                          />
                          <View style={{ flex: 1 }}>
                            <Text
                              numberOfLines={1}
                              ellipsizeMode="middle"
                              style={{ color: colors.text, fontSize: fontSize.md }}
                            >
                              {file.name}
                            </Text>
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
                                <>
                                  <IconButton
                                    icon="create-outline"
                                    label={`${file.name} 이름 변경`}
                                    onPress={() => startRename(file.path, false)}
                                  />
                                  <IconButton
                                    icon="trash-outline"
                                    label={`${file.name} 삭제`}
                                    tone="danger"
                                    onPress={() => void remove(file.path, false)}
                                  />
                                </>
                              ) : null}
                            </>
                          )}
                        </Pressable>
                      )}
                    </View>
                  ))}
                </>
              )}
            </Card>
          )}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * 이름 변경 중인 행. 전체 경로를 고쳐 확인하면 movePath 로 옮긴다 —
 * 다른 폴더 경로를 적으면 이동이 된다.
 */
function RenameRow({
  icon,
  value,
  busy,
  hint,
  onChange,
  onConfirm,
  onCancel,
}: {
  icon: ReturnType<typeof iconForMime> | 'folder';
  value: string;
  busy: boolean;
  hint?: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: spacing.sm }}>
      <Row gap={spacing.md}>
        <Ionicons
          name={icon}
          size={20}
          color={icon === 'folder' ? colors.accent : colors.textMuted}
        />
        <Input
          value={value}
          onChangeText={onChange}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onSubmitEditing={onConfirm}
          placeholder="새 경로 (예: 문서/회의록.md)"
          accessibilityLabel="새 경로"
          style={{ flex: 1, fontFamily: monoFont, fontSize: fontSize.sm }}
        />
      </Row>
      {hint ? <Caption>{hint}</Caption> : null}
      <Row gap={spacing.sm} style={{ justifyContent: 'flex-end' }}>
        <Button label="취소" variant="ghost" compact onPress={onCancel} disabled={busy} />
        <Button label="확인" compact onPress={onConfirm} loading={busy} />
      </Row>
    </View>
  );
}

/** 과거 시점 배너 설명. 이력 화면이 넘겨준 메시지·시간이 있으면 그것을, 없으면 id 일부를 쓴다. */
function describeSnapshot(id: string, message?: string, at?: string): string {
  const createdAt = Number(at);
  if (at && Number.isFinite(createdAt)) {
    return `${message || '변경'} · ${formatRelativeTime(createdAt)}`;
  }
  return `스냅샷 ${id.slice(0, 8)}`;
}

function iconForMime(mimeType: string): 'image-outline' | 'musical-notes-outline' | 'videocam-outline' | 'document-text-outline' | 'archive-outline' | 'document-outline' {
  if (mimeType.startsWith('image/')) return 'image-outline';
  if (mimeType.startsWith('audio/')) return 'musical-notes-outline';
  if (mimeType.startsWith('video/')) return 'videocam-outline';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'document-text-outline';
  if (mimeType === 'application/zip' || mimeType === 'application/gzip') return 'archive-outline';
  return 'document-outline';
}
