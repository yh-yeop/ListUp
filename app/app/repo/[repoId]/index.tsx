import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { DragDrop } from '../../../src/components/DragDrop';
import { FileSearch } from '../../../src/components/FileSearch';
import { MovePicker } from '../../../src/components/MovePicker';
import { TransferProgress } from '../../../src/components/TransferProgress';
import { ApiError, api, getMaxUploadBytes, type UploadSource } from '../../../src/api/client';
import { confirmAction, notify, notifyError, notifySuccess, notifyWarning } from '../../../src/lib/dialogs';
import { downloadFromRepo, pickFiles, pickFolder } from '../../../src/lib/files';
import { localFolderSupported } from '../../../src/lib/local-folder';
import { describeMoves, fileMoves, planMoveInto, topLevelOnly, type MoveItem } from '../../../src/lib/move';
import { uploadAndCommit, type UploadItem, type UploadProgress } from '../../../src/lib/transfer';
import { useAbortable } from '../../../src/lib/useAbortable';
import { LEVEL_1_4, LEVEL_1_5, useServerLevel } from '../../../src/lib/useServerLevel';
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
/** 폴더 동기화는 폴더에 쓸 수 있는 곳에서만 — PC 앱과 안드로이드. */
const syncSupported = Platform.OS === 'android' || (Platform.OS === 'web' && typeof window !== 'undefined' && 'listupDesktop' in window);

const MAX_FAILURES_SHOWN = 3;

/** 폴더 올리기는 웹(폴더 선택)과 안드로이드(시스템 폴더 선택기)에서만 된다. */
const CAN_PICK_FOLDER = Platform.OS === 'web' || Platform.OS === 'android';

export default function RepoFilesScreen() {
  const {
    repoId,
    snapshot,
    message: snapshotMessage,
    at: snapshotAt,
    path: pathParam,
    highlight,
  } = useLocalSearchParams<{ repoId: string; snapshot?: string; message?: string; at?: string; path?: string; highlight?: string }>();
  const { colors } = useTheme();
  // 찾기 결과·링크로 바로 폴더에 들어올 수 있다(?path=). highlight 는 그 파일 줄을 잠깐 밝힌다.
  const [path, setPath] = useState(pathParam ?? '');
  useEffect(() => {
    if (pathParam !== undefined) setPath(pathParam);
  }, [pathParam]);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const uploading = progress !== null;
  const uploadControl = useAbortable();
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState(false);
  // 여러 개 고르기(옮기기·지우기)와 옮길 곳 고르기.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, MoveItem>>(new Map());
  const [moveItems, setMoveItems] = useState<MoveItem[]>([]);
  const [moving, setMoving] = useState(false);

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
  const mirror = repo?.mirror ?? null;
  const serverLevel = useServerLevel();
  // 과거 시점에서는 편집 권한이 있어도 바꿀 수 없다. 다른 서버를 따라가는 저장소도 여기서는 바꾸지 않는다.
  const canEdit = isEditor && !snapshotId && !mirror;
  // 과거 시점으로 되돌리기 (1.4.0 서버부터).
  const canRestore = isEditor && !!snapshotId && !mirror && serverLevel >= LEVEL_1_4;
  // 계정 없는 사람에게 링크로 보내기 (1.4.0 서버부터).
  const canShare = isEditor && !snapshotId && serverLevel >= LEVEL_1_4;
  // 열람자는 옮기기를 변경 제안으로 보낸다 (이동 제안은 수준 5 서버부터).
  const canProposeMove = !isEditor && !!repo && !snapshotId && !mirror && serverLevel >= LEVEL_1_5;
  const canMove = canEdit || canProposeMove;
  // 여러 개 고르기·끌어다 놓기는 한 번에 옮기기가 되는 서버에서만.
  const canSelect = canMove && serverLevel >= LEVEL_1_5;
  const canDrag = canSelect && Platform.OS === 'web';
  const [syncingMirror, setSyncingMirror] = useState(false);

  /** 과거 시점의 내용으로 저장소 전체(''), 폴더, 파일 하나를 되돌린다. */
  async function restoreTo(targetPath: string, isFolder: boolean) {
    if (!snapshotId) return;
    const what = targetPath === '' ? '저장소 전체' : isFolder ? `'${targetPath}' 폴더` : `'${targetPath}'`;
    const ok = await confirmAction({
      title: `${what}를 이 시점으로 되돌릴까요?`,
      message:
        (isFolder || targetPath === ''
          ? '그 시점에 없던 파일은 지워지고, 바뀐 파일은 그때 내용으로 돌아갑니다. '
          : '이 파일을 그때 내용으로 바꿉니다. ') +
        '되돌린 것도 변경 이력에 남으므로 다시 되돌릴 수 있습니다.',
      confirmLabel: '되돌리기',
    });
    if (!ok) return;
    setBusyPath(targetPath || '/');
    try {
      const result = await api.restore(repoId, snapshotId, targetPath || undefined);
      if (result.unchanged) notify('바뀐 것이 없습니다.', '지금과 그 시점의 내용이 같습니다.');
      else {
        const parts = [
          result.added ? `되살림 ${result.added}` : '',
          result.updated ? `되돌림 ${result.updated}` : '',
          result.deleted ? `지움 ${result.deleted}` : '',
        ].filter(Boolean);
        notifySuccess('되돌렸습니다.', parts.join(' · '));
      }
      backToPresent();
    } catch (err) {
      notifyError('되돌리지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyPath(null);
    }
  }

  async function syncMirrorNow() {
    setSyncingMirror(true);
    try {
      const { result } = await api.syncMirror(repoId);
      if (result.changed) notifySuccess('원본에서 바뀐 것을 가져왔습니다.', result.fetched ? `새 내용 ${result.fetched}개 (${formatBytes(result.fetchedBytes)})` : undefined);
      else notify('원본과 같습니다.');
    } catch (err) {
      notifyError('가져오지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSyncingMirror(false);
      state.refresh();
    }
  }

  async function stopMirroring() {
    const ok = await confirmAction({
      title: '따라가기를 그만둘까요?',
      message: '지금 가진 파일과 이력은 그대로 남고, 이 저장소는 보통 저장소가 됩니다. 원본의 변경은 더 따라오지 않습니다.',
      confirmLabel: '그만두기',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.stopMirror(repoId);
      notifySuccess('따라가기를 그만뒀습니다.');
    } catch (err) {
      notifyError('그만두지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      state.refresh();
    }
  }

  function openFolder(nextPath: string) {
    setEditing(null);
    setSelected(new Map());
    setPath(nextPath);
  }

  function toggleSelected(item: MoveItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.path)) next.delete(item.path);
      else next.set(item.path, item);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Map());
  }

  /** 끌기 시작한 줄이 고른 것 가운데 하나면 고른 것 전부를, 아니면 그 줄 하나를 싣는다. */
  function dragItems(item: MoveItem): MoveItem[] {
    return selected.has(item.path) ? [...selected.values()] : [item];
  }

  /**
   * 고른 것을 targetDir 로 옮긴다. 편집자는 바로(여럿이면 스냅샷 하나로), 열람자는 이동 제안으로 — 반영되면 옮겨진다.
   * 끌어다 놓기·옮길 곳 고르기·여러 개 고르기가 모두 여기로 온다.
   */
  async function performMove(items: MoveItem[], targetDir: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const plan = planMoveInto(items, targetDir);
    if (!plan.ok) {
      notifyWarning(plan.reason);
      return false;
    }
    const where = targetDir ? `'${targetDir}'` : '맨 위';
    if (options.confirm || !isEditor) {
      const ok = await confirmAction({
        title: isEditor ? `${where}로 옮길까요?` : `${where}로 옮기기를 제안할까요?`,
        message: isEditor
          ? describeMoves(plan.moves)
          : `${describeMoves(plan.moves)}\n\n열람 권한이라 변경 제안으로 보냅니다. 편집자가 반영하면 옮겨집니다.`,
        confirmLabel: isEditor ? '옮기기' : '제안하기',
      });
      if (!ok) return false;
    }
    setMoving(true);
    try {
      if (isEditor) {
        if (plan.moves.length === 1) await api.movePath(repoId, plan.moves[0].from, plan.moves[0].to);
        else await api.moveMany(repoId, plan.moves);
        notifySuccess(`옮겼습니다 — ${describeMoves(plan.moves)}`, '변경 이력에서 되돌릴 수 있습니다.');
      } else {
        // 제안은 파일마다 적는다 — 폴더는 안의 파일로 편다.
        const files: string[] = [];
        for (const move of plan.moves) {
          const folder = items.find((item) => item.path === move.from)?.isFolder;
          if (!folder) files.push(move.from);
          else {
            const { tree } = await api.listFiles(repoId, move.from, undefined, { recursive: true });
            files.push(...tree.files.map((file) => file.path));
          }
        }
        const changes = fileMoves(plan.moves, files);
        if (changes.length === 0) {
          notifyWarning('옮길 파일이 없습니다.');
          return false;
        }
        const { proposal } = await api.createProposal(repoId, {
          title: `옮기기: ${describeMoves(plan.moves)}`.slice(0, 120),
          changes,
        });
        notifySuccess(`변경 제안 #${proposal.number} 로 보냈습니다.`, '편집자가 반영하면 옮겨집니다.');
        router.push(`/proposal/${proposal.id}`);
      }
      setMoveItems([]);
      stopSelecting();
      state.refresh();
      return true;
    } catch (err) {
      notifyError(isEditor ? '옮기지 못했습니다.' : '제안하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
      return false;
    } finally {
      setMoving(false);
    }
  }

  /** 고른 것을 한 번에 지운다 — 커밋 하나로(편집자). 폴더는 안의 파일로 편다. */
  async function removeSelected() {
    const items = topLevelOnly([...selected.values()]);
    if (items.length === 0) return;
    const ok = await confirmAction({
      title: `${items.length}개를 지울까요?`,
      message: `${items.map((item) => item.path + (item.isFolder ? '/' : '')).slice(0, 8).join('\n')}${items.length > 8 ? '\n…' : ''}\n\n변경 이력에는 남습니다.`,
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;
    setMoving(true);
    try {
      const files: string[] = [];
      for (const item of items) {
        if (!item.isFolder) files.push(item.path);
        else {
          const { tree } = await api.listFiles(repoId, item.path, undefined, { recursive: true });
          files.push(...tree.files.map((file) => file.path));
        }
      }
      await api.commitFiles(
        repoId,
        files.map((file) => ({ path: file, blobHash: null })),
        `삭제 ${items.length}개: ${items.map((item) => item.path).slice(0, 5).join(', ')}${items.length > 5 ? ' …' : ''}`,
      );
      notifySuccess(`${items.length}개를 지웠습니다.`, '변경 이력에서 되돌릴 수 있습니다.');
      stopSelecting();
      state.refresh();
    } catch (err) {
      notifyError('지우지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setMoving(false);
    }
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
      notifyWarning(`${names}${more} 은(는) ${formatBytes(maxBytes)} 를 넘어 올릴 수 없습니다.`);
    }
    return sources.filter((source) => source.size <= maxBytes);
  }

  /** 조각으로 나눠 올리고 커밋 하나로 반영한 뒤, 결과를 알려 준다. */
  async function runUpload(items: UploadItem[]) {
    setProgress({ sentBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: items.length, current: '' });
    const signal = uploadControl.start();
    try {
      const result = await uploadAndCommit(repoId, items, setProgress, signal);
      const { failures, commit } = result;
      if (result.cancelled) {
        notify('올리기를 멈췄습니다.', '아무것도 반영하지 않았습니다. 저장소는 그대로입니다.');
      } else if (failures.length > 0) {
        const shown = failures.slice(0, MAX_FAILURES_SHOWN).map((f) => `${f.item.source.name}: ${f.message}`);
        const more = failures.length - shown.length;
        notifyWarning(
          `${result.uploaded.length}개 올렸습니다.`,
          `${failures.length}개는 올리지 못했습니다.\n${shown.join('\n')}${more > 0 ? `\n외 ${more}건 더` : ''}`,
        );
      } else if (commit && items.length > 1) {
        const parts = [
          commit.added ? `추가 ${commit.added}` : '',
          commit.updated ? `수정 ${commit.updated}` : '',
        ].filter(Boolean);
        // 저장소에 이미 있던 내용은 보내지 않았다 — 얼마나 아꼈는지 알려 준다.
        const skipped = result.instant > 0 ? `이미 있던 ${result.instant}개는 보내지 않았습니다.` : undefined;
        if (parts.length > 0) notifySuccess(`${items.length}개 올렸습니다 — ${parts.join(' · ')}`, skipped);
        else notify('바뀐 파일이 없습니다.', skipped);
      }
    } catch (err) {
      notifyError('반영하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      uploadControl.finish();
      setProgress(null);
      state.refresh();
    }
  }

  async function upload() {
    if (uploading) return;
    let sources: UploadSource[];
    try {
      sources = await pickFiles(true);
    } catch {
      notifyError('파일을 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;
    const accepted = await withinLimit(sources);
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

    await runUpload(
      accepted.map((source) => ({ source, path: path ? `${path}/${source.name}` : source.name })),
    );
  }

  /** 폴더를 통째로 — 폴더 구조 그대로 지금 폴더 아래에 올리고 커밋 하나로 반영한다. */
  async function uploadFolder() {
    if (uploading) return;
    let sources: UploadSource[];
    try {
      sources = await pickFolder();
    } catch {
      notifyError('폴더를 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;
    const accepted = await withinLimit(sources);
    if (accepted.length === 0) return;

    const folderName = (accepted[0].relativePath ?? accepted[0].name).split('/')[0];
    const totalBytes = accepted.reduce((sum, source) => sum + source.size, 0);
    const ok = await confirmAction({
      title: `'${folderName}' 폴더를 올릴까요?`,
      message: `파일 ${accepted.length}개 · ${formatBytes(totalBytes)}\n${
        path ? `'${path}' 아래에` : '저장소 맨 위에'
      } 폴더 구조 그대로 올립니다. 같은 경로의 파일은 새 내용으로 바뀌고, 이전 버전은 변경 이력에 남습니다.`,
      confirmLabel: '올리기',
    });
    if (!ok) return;
    await runUpload(
      accepted.map((source) => {
        const inner = source.relativePath ?? source.name;
        return { source, path: path ? `${path}/${inner}` : inner };
      }),
    );
  }

  /** 파일 하나, 또는 폴더를 zip 으로 받는다. */
  async function download(targetPath: string, fileName: string, archive = false) {
    setBusyPath(targetPath);
    try {
      const result = await downloadFromRepo(repoId, { path: targetPath, snapshotId, archive, fileName });
      if (result.message) (result.ok ? notifySuccess : notifyError)(result.message);
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

          {!snapshotId && serverLevel >= LEVEL_1_5 ? <FileSearch repoId={repoId} placeholder="이 저장소에서 파일 찾기" /> : null}

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
                  <Caption>
                    {canRestore
                      ? '이 시점의 파일을 내려받거나, 지금 저장소를 이 시점으로 되돌릴 수 있습니다.'
                      : '이 시점의 파일은 내려받기만 할 수 있습니다.'}
                  </Caption>
                </View>
              </Row>
              <Row gap={spacing.sm} wrap>
                <Button
                  label="현재로 돌아가기"
                  icon="arrow-forward-outline"
                  variant="secondary"
                  compact
                  onPress={backToPresent}
                />
                {canRestore ? (
                  <Button
                    label={path ? `이 폴더를 이 시점으로` : '저장소 전체를 이 시점으로'}
                    icon="arrow-undo-outline"
                    compact
                    loading={busyPath === (path || '/')}
                    onPress={() => void restoreTo(path, true)}
                  />
                ) : null}
              </Row>
            </View>
          ) : mirror ? (
            <View style={{ backgroundColor: colors.accentSoft, borderRadius: radius.md, padding: spacing.md, gap: spacing.md }}>
              <Row gap={spacing.sm} style={{ alignItems: 'flex-start' }}>
                <Ionicons name="git-network-outline" size={18} color={colors.accent} style={{ marginTop: 1 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Body style={{ fontWeight: '600', color: colors.accent }}>다른 서버를 따라가는 저장소</Body>
                  <Caption>원본: {mirror.sourceUrl}</Caption>
                  <Caption>
                    {mirror.syncing || syncingMirror
                      ? '지금 가져오는 중…'
                      : mirror.lastSyncedAt
                        ? `마지막으로 가져옴: ${formatRelativeTime(mirror.lastSyncedAt)}`
                        : '아직 가져오지 않았습니다.'}
                  </Caption>
                  {mirror.lastError ? <Caption style={{ color: colors.danger }}>최근 실패: {mirror.lastError}</Caption> : null}
                  <Caption>여기서는 파일을 바꿀 수 없습니다. 원본 서버에서 바꾸면 따라옵니다.</Caption>
                </View>
              </Row>
              {repo?.role === 'owner' ? (
                <Row gap={spacing.sm} wrap>
                  <Button label="지금 가져오기" icon="refresh" compact loading={syncingMirror} onPress={() => void syncMirrorNow()} />
                  <Button label="따라가기 그만두기" variant="secondary" compact onPress={() => void stopMirroring()} />
                </Row>
              ) : null}
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
              {canEdit && CAN_PICK_FOLDER ? (
                <Button
                  label="폴더 올리기"
                  icon="folder-open-outline"
                  variant="secondary"
                  onPress={uploadFolder}
                  disabled={uploading}
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
                  disabled={uploading}
                />
              ) : null}
              {syncSupported && serverLevel >= LEVEL_1_4 ? (
                <Button
                  label="폴더 동기화"
                  icon="sync-outline"
                  variant="secondary"
                  onPress={() => router.push(`/repo/${repoId}/sync?path=${encodeURIComponent(path)}`)}
                  disabled={uploading}
                />
              ) : null}
              {canShare && canEdit ? (
                <Button
                  label="받기 함 만들기"
                  icon="mail-unread-outline"
                  variant="secondary"
                  onPress={() => router.push(`/repo/${repoId}/shares?inbox=${encodeURIComponent(path)}`)}
                />
              ) : null}
            </Row>
          )}

          {progress ? (
            <TransferProgress progress={progress} onCancel={uploadControl.cancel} cancelling={uploadControl.cancelling} />
          ) : null}

          {!isEditor && !snapshotId && !mirror ? (
            <Caption>
              열람 권한이라 파일을 직접 바꿀 수는 없지만, 변경 제안을 올리면 편집자가 검토 후
              반영합니다.
            </Caption>
          ) : null}

          <Row gap={spacing.sm} style={{ alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Breadcrumb
                path={path}
                onNavigate={openFolder}
                onDropItems={canDrag ? (target, items) => void performMove(items, target) : undefined}
              />
            </View>
            {canSelect && tree && (tree.dirs.length > 0 || tree.files.length > 0) ? (
              <Button
                label={selecting ? '고르기 끝' : '여러 개 고르기'}
                icon={selecting ? 'close' : 'checkbox-outline'}
                variant="ghost"
                compact
                onPress={() => (selecting ? stopSelecting() : setSelecting(true))}
              />
            ) : null}
          </Row>

          {selecting ? (
            <Card style={{ gap: spacing.sm, paddingVertical: spacing.md }}>
              <Row gap={spacing.sm} wrap style={{ alignItems: 'center' }}>
                <Body style={{ fontWeight: '600', flex: 1 }}>{selected.size}개 고름</Body>
                <Button
                  label="모두"
                  variant="ghost"
                  compact
                  onPress={() =>
                    setSelected(
                      new Map<string, MoveItem>([
                        ...(tree?.dirs ?? []).map((dir): [string, MoveItem] => [dir.path, { path: dir.path, isFolder: true }]),
                        ...(tree?.files ?? []).map((file): [string, MoveItem] => [file.path, { path: file.path, isFolder: false }]),
                      ]),
                    )
                  }
                />
                <Button
                  label={isEditor ? '옮기기' : '옮기기 제안'}
                  icon="arrow-redo-outline"
                  compact
                  disabled={selected.size === 0 || moving}
                  onPress={() => setMoveItems([...selected.values()])}
                />
                {canEdit ? (
                  <Button
                    label="지우기"
                    icon="trash-outline"
                    variant="secondary"
                    compact
                    disabled={selected.size === 0 || moving}
                    loading={moving && moveItems.length === 0}
                    onPress={() => void removeSelected()}
                  />
                ) : null}
              </Row>
              {canDrag ? <Caption>고른 것을 폴더나 위의 경로로 끌어다 놓아도 옮겨집니다.</Caption> : null}
            </Card>
          ) : null}

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
                        <DragDrop
                          drag={canDrag ? () => dragItems({ path: dir.path, isFolder: true }) : undefined}
                          onDrop={canDrag ? (items) => void performMove(items, dir.path) : undefined}
                        >
                        <Pressable
                          onPress={() => (selecting ? toggleSelected({ path: dir.path, isFolder: true }) : openFolder(dir.path))}
                          accessibilityRole={selecting ? 'checkbox' : 'button'}
                          aria-checked={selecting ? selected.has(dir.path) : undefined}
                          accessibilityLabel={selecting ? `${dir.name} 폴더 고르기` : `${dir.name} 폴더 열기`}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: spacing.md,
                            paddingVertical: spacing.md,
                            paddingHorizontal: spacing.lg,
                            backgroundColor: selected.has(dir.path) ? colors.accentSoft : pressed ? colors.surfaceAlt : 'transparent',
                          })}
                        >
                          {selecting ? (
                            <Ionicons
                              name={selected.has(dir.path) ? 'checkbox' : 'square-outline'}
                              size={20}
                              color={selected.has(dir.path) ? colors.accent : colors.textMuted}
                            />
                          ) : null}
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
                          {selecting ? null : busyPath === dir.path ? (
                            <ActivityIndicator size="small" color={colors.textMuted} />
                          ) : (
                            <IconButton
                              icon="download-outline"
                              label={`${dir.name} 폴더를 zip 으로 받기`}
                              onPress={() => void download(dir.path, `${dir.name}.zip`, true)}
                            />
                          )}
                          {canRestore && !selecting ? (
                            <IconButton
                              icon="arrow-undo-outline"
                              label={`${dir.name} 폴더를 이 시점으로 되돌리기`}
                              onPress={() => void restoreTo(dir.path, true)}
                            />
                          ) : null}
                          {canShare && !selecting ? (
                            <IconButton
                              icon="share-social-outline"
                              label={`${dir.name} 폴더를 링크로 보내기`}
                              onPress={() => router.push(`/repo/${repoId}/shares?path=${encodeURIComponent(dir.path)}`)}
                            />
                          ) : null}
                          {canMove && !selecting ? (
                            <IconButton
                              icon="arrow-redo-outline"
                              label={`${dir.name} 폴더 옮기기`}
                              onPress={() => setMoveItems([{ path: dir.path, isFolder: true }])}
                            />
                          ) : null}
                          {canEdit && !selecting ? (
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
                          {selecting ? null : <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />}
                        </Pressable>
                        </DragDrop>
                      )}
                    </View>
                  ))}

                  {tree.files.map((file, index) => (
                    <View key={file.path} style={highlight === file.path ? { backgroundColor: colors.accentSoft } : undefined}>
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
                        <DragDrop drag={canDrag ? () => dragItems({ path: file.path, isFolder: false }) : undefined}>
                        <Pressable
                          onPress={() => (selecting ? toggleSelected({ path: file.path, isFolder: false }) : void download(file.path, file.name))}
                          accessibilityRole={selecting ? 'checkbox' : 'button'}
                          aria-checked={selecting ? selected.has(file.path) : undefined}
                          accessibilityLabel={selecting ? `${file.name} 고르기` : `${file.name} 내려받기`}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: spacing.md,
                            paddingVertical: spacing.md,
                            paddingHorizontal: spacing.lg,
                            backgroundColor: selected.has(file.path) ? colors.accentSoft : pressed ? colors.surfaceAlt : 'transparent',
                          })}
                        >
                          {selecting ? (
                            <Ionicons
                              name={selected.has(file.path) ? 'checkbox' : 'square-outline'}
                              size={20}
                              color={selected.has(file.path) ? colors.accent : colors.textMuted}
                            />
                          ) : null}
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
                          {selecting ? null : busyPath === file.path ? (
                            <ActivityIndicator size="small" color={colors.textMuted} />
                          ) : (
                            <>
                              <IconButton
                                icon="download-outline"
                                label={`${file.name} 내려받기`}
                                onPress={() => void download(file.path, file.name)}
                              />
                              {canRestore ? (
                                <IconButton
                                  icon="arrow-undo-outline"
                                  label={`${file.name} 을(를) 이 시점으로 되돌리기`}
                                  onPress={() => void restoreTo(file.path, false)}
                                />
                              ) : null}
                              {canShare ? (
                                <IconButton
                                  icon="share-social-outline"
                                  label={`${file.name} 을(를) 링크로 보내기`}
                                  onPress={() => router.push(`/repo/${repoId}/shares?path=${encodeURIComponent(file.path)}`)}
                                />
                              ) : null}
                              {canMove ? (
                                <IconButton
                                  icon="arrow-redo-outline"
                                  label={`${file.name} 옮기기`}
                                  onPress={() => setMoveItems([{ path: file.path, isFolder: false }])}
                                />
                              ) : null}
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
                        </DragDrop>
                      )}
                    </View>
                  ))}
                </>
              )}
            </Card>
          )}
        </>
      ) : null}
      <MovePicker
        repoId={repoId}
        items={moveItems}
        startDir={path}
        busy={moving}
        confirmLabel={isEditor ? '여기로 옮기기' : '여기로 옮기기 제안'}
        onCancel={() => setMoveItems([])}
        onConfirm={(target) => void performMove(moveItems, target)}
      />
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
