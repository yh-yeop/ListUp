import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, Text, View } from 'react-native';
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
import { SearchResults } from '../../../src/components/SearchResults';
import { TransferProgress, useTransferControl } from '../../../src/components/TransferProgress';
import { ApiError, api, getMaxUploadBytes, type UploadSource } from '../../../src/api/client';
import { confirmAction, notify, notifyError, notifySuccess } from '../../../src/lib/dialogs';
import { downloadFromRepo, pickFiles, pickFolder } from '../../../src/lib/files';
import { listRepoFolder } from '../../../src/lib/folder-compare';
import { localFolderSupported } from '../../../src/lib/local-folder';
import {
  remoteFilesOf,
  splitUnchanged,
  uploadAndCommit,
  type RemoteFiles,
  type UploadItem,
  type UploadProgress,
} from '../../../src/lib/transfer';
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

/** 폴더 올리기는 웹(폴더 선택)과 안드로이드(시스템 폴더 선택기)에서만 된다. */
const CAN_PICK_FOLDER = Platform.OS === 'web' || Platform.OS === 'android';

export default function RepoFilesScreen() {
  const {
    repoId,
    snapshot,
    message: snapshotMessage,
    at: snapshotAt,
  } = useLocalSearchParams<{ repoId: string; snapshot?: string; message?: string; at?: string }>();
  const { colors } = useTheme();
  const [path, setPath] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const uploading = progress !== null;
  // 선택기가 돌아온 뒤 올리기 시작까지(크기 검사·목록 대조·확인) 다시 누르지 못하게 한다.
  const [preparing, setPreparing] = useState(false);
  const transfer = useTransferControl('올리던 파일은 끊고, 그때까지 다 올린 파일만 저장소에 반영합니다.');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** ⋯ 로 펼친 행의 경로 — 그 행 아래에 버전·이름 변경·삭제를 글자 버튼으로 보인다. 한 번에 하나만. */
  const [menuPath, setMenuPath] = useState<string | null>(null);
  /** 저장소 전체 파일 이름 검색어. 있으면 폴더 목록 대신 검색 결과를 보인다. */
  const [query, setQuery] = useState('');

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
    setMenuPath(null);
    setPath(nextPath);
  }

  function toggleMenu(targetPath: string) {
    setMenuPath((prev) => (prev === targetPath ? null : targetPath));
  }

  /** 펼친 메뉴의 동작 — 메뉴를 닫고 실행한다. */
  function fromMenu(action: () => void) {
    return () => {
      setMenuPath(null);
      action();
    };
  }

  function openVersions(filePath: string) {
    router.push(`/repo/${repoId}/versions?path=${encodeURIComponent(filePath)}`);
  }

  /** snapshot 파라미터를 지워 현재 시점으로 돌아간다. 보고 있던 폴더는 유지된다. */
  function backToPresent() {
    router.setParams({ snapshot: undefined, message: undefined, at: undefined });
  }

  /** 서버가 거부할 크기는 올리지 않고 바로 안내한다. 한도는 서버 설정을 따른다. */
  async function withinLimit(sources: UploadSource[]): Promise<UploadSource[]> {
    const maxBytes = await getMaxUploadBytes();
    const tooLarge = sources.filter((source) => source.size > maxBytes);
    if (tooLarge.length > 0) {
      const names = tooLarge.slice(0, MAX_FAILURES_SHOWN).map((source) => source.name).join(', ');
      const more = tooLarge.length > MAX_FAILURES_SHOWN ? ` 외 ${tooLarge.length - MAX_FAILURES_SHOWN}개` : '';
      notifyError(`${names}${more} 은(는) ${formatBytes(maxBytes)} 를 넘어 올릴 수 없습니다.`);
    }
    return sources.filter((source) => source.size <= maxBytes);
  }

  /** 조각으로 나눠 올리고 커밋 하나로 반영한 뒤, 결과를 알려 준다. */
  async function runUpload(items: UploadItem[]) {
    setProgress({ sentBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: items.length, current: '' });
    const signal = transfer.begin();
    try {
      const result = await uploadAndCommit(repoId, items, setProgress, signal);
      const { failures, commit } = result;
      if (result.cancelled) {
        const done = result.uploaded.length;
        notify(
          `멈췄습니다 — ${done}/${items.length}개 올림`,
          done > 0 ? '다 올린 파일은 저장소에 반영했습니다. 나머지는 올리지 않았습니다.' : '저장소는 그대로입니다.',
        );
      } else if (failures.length > 0) {
        const shown = failures.slice(0, MAX_FAILURES_SHOWN).map((f) => `${f.item.source.name}: ${f.message}`);
        const more = failures.length - shown.length;
        notifyError(
          `${result.uploaded.length}개 올렸습니다.`,
          `${failures.length}개는 올리지 못했습니다.\n${shown.join('\n')}${more > 0 ? `\n외 ${more}건 더` : ''}`,
        );
      } else if (commit && items.length > 1) {
        const parts = [
          commit.added ? `추가 ${commit.added}` : '',
          commit.updated ? `수정 ${commit.updated}` : '',
        ].filter(Boolean);
        if (parts.length > 0) notifySuccess(`${items.length}개 올렸습니다 — ${parts.join(' · ')}`);
        else notify('바뀐 파일이 없습니다.', '올린 파일이 저장소에 있는 것과 같습니다.');
      }
    } catch (err) {
      notifyError('반영하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setProgress(null);
      state.refresh();
    }
  }

  async function upload() {
    if (uploading || preparing) return;
    let sources: UploadSource[];
    try {
      sources = await pickFiles(true);
    } catch {
      notifyError('파일을 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;
    setPreparing(true);
    try {
      const accepted = await withinLimit(sources);
      if (accepted.length === 0) return;

      // 이미 올라가 있는 그대로인 파일은 건너뛴다.
      const { changed, unchanged } = splitUnchanged(
        accepted.map((source) => ({ source, path: path ? `${path}/${source.name}` : source.name })),
        remoteFilesOf(tree?.files ?? []),
      );
      if (changed.length === 0) {
        notify('모두 이미 올라가 있습니다.', '같은 크기의 같은 파일이 저장소에 있어 건너뛰었습니다.');
        return;
      }

      // 현재 폴더에 같은 이름이 있으면 올리기 전에 한 번에 묻는다. 취소하면 아무것도 올리지 않는다.
      const existing = new Set((tree?.files ?? []).map((file) => file.name.normalize('NFC')));
      const overwrites = changed.filter((item) => existing.has(item.source.name.normalize('NFC')));
      if (overwrites.length > 0) {
        const ok = await confirmAction({
          title: '같은 이름의 파일이 있습니다. 덮어쓸까요?',
          message: `${overwrites.map((item) => item.source.name).join(', ')}\n\n이전 버전은 변경 이력에 남아 언제든 다시 볼 수 있습니다.`,
          confirmLabel: '덮어쓰기',
        });
        if (!ok) return;
      }

      if (unchanged.length > 0) notify(`${unchanged.length}개는 이미 올라가 있어 건너뜁니다.`);
      await runUpload(changed);
    } finally {
      setPreparing(false);
    }
  }

  /** 폴더를 통째로 — 폴더 구조 그대로 지금 폴더 아래에 올리고 커밋 하나로 반영한다. */
  async function uploadFolder() {
    if (uploading || preparing) return;
    let sources: UploadSource[];
    try {
      sources = await pickFolder();
    } catch {
      notifyError('폴더를 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;
    setPreparing(true);
    try {
      const accepted = await withinLimit(sources);
      if (accepted.length === 0) return;

      const folderName = (accepted[0].relativePath ?? accepted[0].name).split('/')[0];
      const items = accepted.map((source) => {
        const inner = source.relativePath ?? source.name;
        return { source, path: path ? `${path}/${inner}` : inner };
      });
      // 멈췄다가 같은 폴더를 다시 올리면, 이미 올라간 그대로인 파일은 다시 보내지 않는다.
      let remote: RemoteFiles = new Map();
      try {
        remote = remoteFilesOf(await listRepoFolder(repoId, path ? `${path}/${folderName}` : folderName));
      } catch {
        // 못 받으면 전부 올린다 — 서버가 내용이 같은 파일은 반영하지 않는다.
      }
      const { changed, unchanged } = splitUnchanged(items, remote);
      if (changed.length === 0) {
        notify(`'${folderName}' 은(는) 모두 이미 올라가 있습니다.`, `파일 ${unchanged.length}개가 저장소에 그대로 있습니다.`);
        return;
      }

      const totalBytes = changed.reduce((sum, item) => sum + item.source.size, 0);
      const ok = await confirmAction({
        title: `'${folderName}' 폴더를 올릴까요?`,
        message:
          `파일 ${changed.length}개 · ${formatBytes(totalBytes)}\n` +
          (unchanged.length > 0 ? `이미 올라가 있는 ${unchanged.length}개는 건너뜁니다.\n` : '') +
          `${path ? `'${path}' 아래에` : '저장소 맨 위에'} 폴더 구조 그대로 올립니다. 같은 경로의 파일은 새 내용으로 바뀌고, 이전 버전은 변경 이력에 남습니다.`,
        confirmLabel: '올리기',
      });
      if (!ok) return;
      await runUpload(changed);
    } finally {
      setPreparing(false);
    }
  }

  /** 파일 하나, 또는 폴더를 zip 으로 받는다. */
  async function download(targetPath: string, fileName: string, archive = false) {
    setBusyPath(targetPath);
    try {
      const result = await downloadFromRepo(repoId, { path: targetPath, snapshotId, archive, fileName });
      if (result.message) notify(result.message);
    } catch (err) {
      notifyError('내려받지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyPath(null);
    }
  }

  async function remove(targetPath: string, isFolder: boolean) {
    const ok = await confirmAction({
      title: isFolder ? '이 폴더를 지울까요?' : '이 파일을 지울까요?',
      message: isFolder
        ? `${targetPath} 아래의 파일이 모두 사라집니다. 휴지통(변경 이력)에서 되돌릴 수 있습니다.`
        : `${targetPath} 이(가) 목록에서 사라집니다. 휴지통(변경 이력)에서 되돌릴 수 있습니다.`,
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;

    setBusyPath(targetPath);
    try {
      await api.deletePath(repoId, targetPath);
      notify('지웠습니다.', '변경 이력 → 휴지통에서 되돌릴 수 있습니다.');
      state.refresh();
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '삭제하지 못했습니다.');
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
      notifyError('경로가 올바르지 않습니다.', '빈 이름이나 . / .. 은 쓸 수 없습니다.');
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
      notifyError(err instanceof ApiError ? err.message : '이름을 바꾸지 못했습니다.');
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
                  disabled={preparing}
                />
              ) : null}
              {canEdit && CAN_PICK_FOLDER ? (
                <Button
                  label="폴더 올리기"
                  icon="folder-open-outline"
                  variant="secondary"
                  onPress={uploadFolder}
                  disabled={uploading || preparing}
                />
              ) : null}
              <Button
                label="변경 제안 만들기"
                icon="git-pull-request-outline"
                variant={canEdit ? 'secondary' : 'primary'}
                onPress={() =>
                  router.push(`/repo/${repoId}/new-proposal?path=${encodeURIComponent(path)}`)
                }
              />
              {localFolderSupported ? (
                <Button
                  label="내 폴더와 비교"
                  icon="git-compare-outline"
                  variant="secondary"
                  onPress={() => router.push(`/repo/${repoId}/compare?path=${encodeURIComponent(path)}`)}
                  disabled={uploading || preparing}
                />
              ) : null}
            </Row>
          )}

          {progress ? <TransferProgress progress={progress} control={transfer} /> : null}

          {!isEditor && !snapshotId ? (
            <Caption>
              열람 권한이라 파일을 직접 바꿀 수는 없지만, 변경 제안을 올리면 편집자가 검토 후
              반영합니다.
            </Caption>
          ) : null}

          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="저장소 전체에서 파일 찾기"
            accessibilityLabel="파일 찾기"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            inputMode="search"
          />

          {query.trim() ? (
            <SearchResults
              repoId={repoId}
              query={query}
              snapshotId={snapshotId}
              headId={repo.headSnapshotId}
              busyPath={busyPath}
              onDownload={(filePath, name) => void download(filePath, name)}
              onOpenFolder={(folder) => {
                setQuery('');
                openFolder(folder);
              }}
              onVersions={snapshotId ? undefined : openVersions}
            />
          ) : (
            <>
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
                              {busyPath === dir.path ? (
                                <ActivityIndicator size="small" color={colors.textMuted} />
                              ) : (
                                <IconButton
                                  icon="download-outline"
                                  label={`${dir.name} 폴더를 zip 으로 받기`}
                                  onPress={() => void download(dir.path, `${dir.name}.zip`, true)}
                                />
                              )}
                              {canEdit ? (
                                <IconButton
                                  icon="ellipsis-horizontal"
                                  label={`${dir.name} 폴더 더보기`}
                                  expanded={menuPath === dir.path}
                                  onPress={() => toggleMenu(dir.path)}
                                />
                              ) : null}
                              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                            </Pressable>
                          )}
                          {menuPath === dir.path && canEdit && editing?.path !== dir.path ? (
                            <RowMenu>
                              <Button
                                label="이름 변경"
                                accessibilityLabel={`${dir.name} 폴더 이름 변경`}
                                icon="create-outline"
                                variant="secondary"
                                compact
                                onPress={fromMenu(() => startRename(dir.path, true))}
                              />
                              <Button
                                label="삭제"
                                accessibilityLabel={`${dir.name} 폴더 삭제`}
                                icon="trash-outline"
                                variant="danger"
                                compact
                                onPress={fromMenu(() => void remove(dir.path, true))}
                              />
                            </RowMenu>
                          ) : null}
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
                                  {!snapshotId || canEdit ? (
                                    <IconButton
                                      icon="ellipsis-horizontal"
                                      label={`${file.name} 더보기`}
                                      expanded={menuPath === file.path}
                                      onPress={() => toggleMenu(file.path)}
                                    />
                                  ) : null}
                                </>
                              )}
                            </Pressable>
                          )}
                          {menuPath === file.path && editing?.path !== file.path ? (
                            <RowMenu>
                              {!snapshotId ? (
                                <Button
                                  label="버전"
                                  accessibilityLabel={`${file.name} 버전`}
                                  icon="time-outline"
                                  variant="secondary"
                                  compact
                                  onPress={fromMenu(() => openVersions(file.path))}
                                />
                              ) : null}
                              {canEdit ? (
                                <>
                                  <Button
                                    label="이름 변경"
                                    accessibilityLabel={`${file.name} 이름 변경`}
                                    icon="create-outline"
                                    variant="secondary"
                                    compact
                                    onPress={fromMenu(() => startRename(file.path, false))}
                                  />
                                  <Button
                                    label="삭제"
                                    accessibilityLabel={`${file.name} 삭제`}
                                    icon="trash-outline"
                                    variant="danger"
                                    compact
                                    onPress={fromMenu(() => void remove(file.path, false))}
                                  />
                                </>
                              ) : null}
                            </RowMenu>
                          ) : null}
                        </View>
                      ))}
                    </>
                  )}
                </Card>
              )}
            </>
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

/**
 * ⋯ 로 펼친 행 동작. 좁은 폰에서 아이콘 넷이 이름을 가려, 행에는 받기와 ⋯ 만 두고 나머지는 여기 글자로 보인다.
 * 왼쪽은 행의 이름 줄에 맞춘다(행 여백 + 아이콘 20 + 간격).
 */
function RowMenu({ children }: { children: ReactNode }) {
  return (
    <Row
      gap={spacing.sm}
      wrap
      style={{ paddingLeft: spacing.lg + 20 + spacing.md, paddingRight: spacing.lg, paddingBottom: spacing.md }}
    >
      {children}
    </Row>
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
