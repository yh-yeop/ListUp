import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, Text, View, type TextInput } from 'react-native';
import {
  MAX_FILES_PER_REPO,
  ROLE_LABEL,
  formatBytes,
  formatRelativeTime,
  hasRole,
  normalizePath,
  type FileEntry,
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
import { ApiError, api, getServerLimits, type UploadSource } from '../../../src/api/client';
import { confirmAction, notify, notifyError, notifySuccess, notifyWithAction } from '../../../src/lib/dialogs';
import { parentPath, shortcutsSupported, useKeyboardShortcuts } from '../../../src/lib/shortcuts';
import { nextSortOrder, sortDirs, sortFiles, useFileSort, type SortKey, type SortOrder } from '../../../src/lib/file-sort';
import { downloadFromRepo, pickFiles, pickFolder, type PickedFolder } from '../../../src/lib/files';
import { listRepoFolder } from '../../../src/lib/folder-compare';
import { localFolderSupported } from '../../../src/lib/local-folder';
import { MAX_FAILURES_SHOWN, describeCommitFailure, describeUploadOutcome } from '../../../src/lib/pure/transfer-report';
import { invertChanges, planBulkMove, type ExpectedChange } from '../../../src/lib/pure/bulk-move';
import { TRUNCATED_NOTE, checkUploadPlan, describeUploadCheck } from '../../../src/lib/pure/upload-check';
import {
  CommitFailed,
  isAbandoned,
  remoteFilesOf,
  splitUnchanged,
  uploadAndCommit,
  type RemoteFiles,
  type UploadItem,
} from '../../../src/lib/transfer';
import { TransferBusy, runTransfer, useTransfers } from '../../../src/lib/transfer-store';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

/** 웹에서 칠한 줄을 화면 가운데로 — 긴 폴더에서 찾은 파일이 아래에 묻히지 않게. 앱은 그대로 둔다. */
function scrollIntoViewOnWeb(node: unknown) {
  if (Platform.OS !== 'web' || !node) return;
  (node as { scrollIntoView?: (options: object) => void }).scrollIntoView?.({ block: 'center' });
}

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

/** 폴더 올리기는 웹(폴더 선택)과 안드로이드(시스템 폴더 선택기)에서만 된다. */
const CAN_PICK_FOLDER = Platform.OS === 'web' || Platform.OS === 'android';

export default function RepoFilesScreen() {
  const {
    repoId,
    snapshot,
    message: snapshotMessage,
    at: snapshotAt,
    path: initialPath,
  } = useLocalSearchParams<{ repoId: string; snapshot?: string; message?: string; at?: string; path?: string }>();
  const { colors } = useTheme();
  // 보고 있는 폴더는 주소의 ?path= 에도 남긴다 — 새로고침·북마크·주소 공유로 같은 폴더가 열린다.
  // 주소에서 읽는 것은 처음 한 번뿐이고, 그 뒤로는 이 상태가 기준이다(openFolder 가 주소를 따라 고친다).
  const [path, setPath] = useState(() => (typeof initialPath === 'string' ? (normalizePath(initialPath) ?? '') : ''));
  const [sort, setSort] = useFileSort();
  // 올리기는 화면 밖(전송 스토어)에서 이어진다 — 다른 탭에 다녀와도 이 저장소에 올리는 중이면 버튼을 막는다.
  const transfers = useTransfers(repoId);
  const uploading = transfers.active !== null;
  // 선택기가 돌아온 뒤 올리기 시작까지(크기 검사·목록 대조·확인) 다시 누르지 못하게 한다.
  const [preparing, setPreparing] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** ⋯ 로 펼친 행의 경로 — 그 행 아래에 버전·이름 변경·삭제를 글자 버튼으로 보인다. 한 번에 하나만. */
  const [menuPath, setMenuPath] = useState<string | null>(null);
  /** 저장소 전체 파일 이름 검색어. 있으면 폴더 목록 대신 검색 결과를 보인다. */
  const [query, setQuery] = useState('');
  const searchRef = useRef<TextInput>(null);
  /** 여러 개 고르기 — 지금 폴더의 파일을 골라 한꺼번에 받거나 지운다(폴더는 고르지 않는다). */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  /** 고른 파일을 옮길 폴더 경로를 적는 중이면 그 값. 아니면 null. */
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  /** 찾기 결과에서 폴더를 열었을 때 그 파일 — 폴더 안 여러 줄 중 어느 것인지 잠시 칠해 보인다. */
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [highlight]);

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

  // 이 저장소의 올리기가 끝나면(화면을 떠났다 돌아온 뒤에 끝나도) 목록을 다시 읽는다. 첫 렌더는 건너뛴다.
  const seenFinished = useRef(transfers.finishedSeq);
  useEffect(() => {
    if (seenFinished.current === transfers.finishedSeq) return;
    seenFinished.current = transfers.finishedSeq;
    state.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers.finishedSeq]);

  const repo = state.data?.repo;
  const tree = state.data?.tree;
  const dirs = tree ? sortDirs(tree.dirs, sort) : [];
  const files = tree ? sortFiles(tree.files, sort) : [];
  // 폴더를 옮긴 직후에는 새 목록이 올 때까지 이전 폴더의 tree 가 남는다. 그 기준으로
  // 덮어쓰기 확인·「이미 올라가 있음」 판정을 하면 틀리므로 목록이 최신일 때만 올린다.
  const treeFresh = !state.loading && tree?.path === path;
  const isEditor = hasRole(repo?.role, 'editor');
  // 과거 시점에서는 편집 권한이 있어도 바꿀 수 없다.
  const canEdit = isEditor && !snapshotId;

  function openFolder(nextPath: string) {
    setHighlight(null);
    setEditing(null);
    setMenuPath(null);
    setSelected(new Set());
    setPath(nextPath);
    router.setParams({ path: nextPath || undefined });
  }

  // 웹·PC 앱 단축키(lib/pure/shortcuts.ts). 처리하지 않은 키는 false — 브라우저 기본 동작에 맡긴다.
  useKeyboardShortcuts((action) => {
    switch (action) {
      case 'focus-search':
        searchRef.current?.focus();
        return true;
      case 'folder-up': {
        const parent = query.trim() ? null : parentPath(path);
        if (parent === null) return false;
        openFolder(parent);
        return true;
      }
      case 'escape':
        if (editing) setEditing(null);
        else if (moveTarget !== null) setMoveTarget(null);
        else if (selecting) stopSelecting();
        else if (menuPath) setMenuPath(null);
        else if (query) {
          setQuery('');
          // 칸을 비운 뒤 다음 단축키(? 등)가 칸에 글자로 들어가지 않게 포커스를 놓는다.
          searchRef.current?.blur();
        } else return false;
        return true;
      case 'refresh':
        state.refresh();
        return true;
      case 'help':
        router.push('/help');
        return true;
    }
  });

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
    setMoveTarget(null);
  }

  function toggleSelected(filePath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }

  /** 고른 파일 — 목록이 바뀌어 사라진 것은 빼고, 화면 순서대로. */
  const chosen = files.filter((file) => selected.has(file.path));

  /** 고른 파일을 차례로 받는다. 한 번에 여러 다운로드를 열면 브라우저가 막거나 선택기가 겹친다. */
  async function downloadSelected() {
    if (bulkBusy || chosen.length === 0) return;
    setBulkBusy(true);
    let failed = 0;
    try {
      for (const file of chosen) {
        try {
          const result = await downloadFromRepo(repoId, { path: file.path, snapshotId, archive: false, fileName: file.name });
          if (result.message) notify(result.message);
        } catch {
          failed += 1;
        }
      }
    } finally {
      setBulkBusy(false);
    }
    if (failed > 0) notifyError(`${chosen.length}개 중 ${failed}개를 받지 못했습니다.`);
    else notifySuccess(`${chosen.length}개를 받았습니다.`);
  }

  /** 고른 파일을 커밋 하나로 지운다 — 변경 이력에 한 번으로 남고, 휴지통에서 되돌릴 수 있다. */
  async function deleteSelected() {
    if (bulkBusy || chosen.length === 0) return;
    const names = chosen.slice(0, MAX_FAILURES_SHOWN).map((file) => file.name).join(', ');
    const more = chosen.length > MAX_FAILURES_SHOWN ? ` 외 ${chosen.length - MAX_FAILURES_SHOWN}개` : '';
    const ok = await confirmAction({
      title: `고른 파일 ${chosen.length}개를 지울까요?`,
      message: `${names}${more} — 휴지통(변경 이력)에서 되돌릴 수 있습니다.`,
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      // 목록에서 본 내용 그대로일 때만 — 그 사이 다른 사람이 올린 새 버전을 모르고 지우지 않게(서버가 409).
      const changes = chosen.map((file) => ({ path: file.path, blobHash: null, expect: file.blobHash }));
      const message = `파일 ${chosen.length}개 삭제`;
      await api.commitFiles(repoId, changes, message);
      offerUndo(`${chosen.length}개를 지웠습니다.`, changes, message);
      stopSelecting();
      state.refresh();
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '지우지 못했습니다.');
      // 그 사이 다른 사람이 바꿨다(409) — 지금 목록을 보여 줘야 다시 고를 수 있다.
      if (err instanceof ApiError && err.status === 409) state.refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * 고른 파일을 한 폴더로 — 커밋 하나에 "새 경로 = 같은 내용 + 옛 경로 삭제" 를 담는다(lib/pure/bulk-move.ts). 커밋은 있는
   * 파일을 조용히 덮어쓰므로 옮길 폴더의 이름을 먼저 보고, 겹치면 아무것도 옮기지 않는다.
   */
  async function moveSelected() {
    if (bulkBusy || moveTarget === null || chosen.length === 0) return;
    const dest = moveTarget.trim() === '' ? '' : normalizePath(moveTarget);
    if (dest === null) {
      notifyError('폴더 경로가 올바르지 않습니다.', '빈 이름이나 . / .. 은 쓸 수 없습니다.');
      return;
    }
    setBulkBusy(true);
    try {
      let taken: string[] = [];
      try {
        const { tree: there } = await api.listFiles(repoId, dest);
        taken = [...there.dirs.map((dir) => dir.name), ...there.files.map((file) => file.name)];
      } catch (err) {
        // 아직 없는 폴더면 새로 생긴다.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      const plan = planBulkMove(chosen, dest, taken);
      if (plan.clashes.length > 0) {
        notifyError(
          `${dest || '맨 위'} 에 같은 이름이 있어 옮기지 않았습니다.`,
          `${plan.clashes.slice(0, MAX_FAILURES_SHOWN).join(', ')}${plan.clashes.length > MAX_FAILURES_SHOWN ? ` 외 ${plan.clashes.length - MAX_FAILURES_SHOWN}개` : ''}`,
        );
        return;
      }
      if (plan.changes.length === 0) {
        notify('이미 그 폴더에 있습니다.');
        return;
      }
      const moved = plan.changes.length / 2;
      const message = `파일 ${moved}개를 ${dest || '맨 위'}(으)로 옮김`;
      await api.commitFiles(repoId, plan.changes, message);
      offerUndo(`${moved}개를 ${dest || '맨 위'}(으)로 옮겼습니다.`, plan.changes, message);
      stopSelecting();
      state.refresh();
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '옮기지 못했습니다.');
      // 그 사이 다른 사람이 바꿨다(409) — 지금 목록을 보여 줘야 다시 고를 수 있다.
      if (err instanceof ApiError && err.status === 409) state.refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * 방금 한 지우기·옮기기를 토스트의 「되돌리기」로 무른다 — 같은 내용으로 맞바꾼 커밋 하나(lib/pure/bulk-move.ts
   * invertChanges). 그 사이 누가 또 바꿨으면 서버가 409 로 거절하므로 남의 새 버전을 덮지 않는다.
   */
  function offerUndo(title: string, changes: ExpectedChange[], message: string) {
    offerUndoWith(title, '실수였다면 바로 되돌릴 수 있습니다. 나중에는 변경 이력 → 휴지통에서.', async () => {
      await api.commitFiles(repoId, invertChanges(changes), `되돌리기: ${message}`);
    });
  }

  /** 「되돌리기」 버튼이 달린 안내 — 누르면 `undo` 를 하고 결과를 알린 뒤 목록을 다시 읽는다. */
  function offerUndoWith(title: string, message: string, undo: () => Promise<void>) {
    notifyWithAction(title, message, {
      label: '되돌리기',
      onPress: () => {
        void (async () => {
          try {
            await undo();
            notifySuccess('되돌렸습니다.');
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              notifyError('그 사이 바뀐 파일이 있어 되돌리지 않았습니다.', '변경 이력 → 휴지통에서 하나씩 되돌릴 수 있습니다.');
            } else {
              notifyError('되돌리지 못했습니다.', err instanceof ApiError ? err.message : undefined);
            }
          } finally {
            state.refresh();
          }
        })();
      },
    });
  }

  /** 경로를 클립보드로 — 채팅으로 "이 파일" 을 가리킬 때. */
  async function copyPath(targetPath: string) {
    await Clipboard.setStringAsync(targetPath);
    notifySuccess('경로를 복사했습니다.', targetPath);
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

  /** 서버가 거부할 크기는 올리지 않고 바로 안내한다. 한도는 서버 설정을 따른다(getServerLimits). */
  function withinLimit(sources: UploadSource[], maxBytes: number): UploadSource[] {
    const tooLarge = sources.filter((source) => source.size > maxBytes);
    if (tooLarge.length > 0) {
      const names = tooLarge.slice(0, MAX_FAILURES_SHOWN).map((source) => source.name).join(', ');
      const more = tooLarge.length > MAX_FAILURES_SHOWN ? ` 외 ${tooLarge.length - MAX_FAILURES_SHOWN}개` : '';
      notifyError(`${names}${more} 은(는) ${formatBytes(maxBytes)} 를 넘어 올릴 수 없습니다.`);
    }
    return sources.filter((source) => source.size <= maxBytes);
  }

  /** 저장소 전체 파일(하위 폴더까지). 전체 목록을 주지 않는 옛 서버(1.2 까지)거나 받지 못하면 null. */
  async function listWholeRepo(): Promise<FileEntry[] | null> {
    try {
      const { tree: whole } = await api.listFiles(repoId, '', undefined, { recursive: true });
      return whole.recursive ? whole.files : null;
    } catch {
      return null;
    }
  }

  /**
   * 올리기 전 검사(lib/pure/upload-check.ts) — 파일·폴더 이름 겹침, 저장소 파일 수·용량 한도는 커밋에서야 막혀
   * 다 올린 바이트가 헛것이 되므로 미리 본다. 걸리면 알리고 false(아무것도 올리지 않는다).
   * 전체 목록이 없으면 겹침만, 서버가 용량 한도를 알려 주지 않으면 용량만 건너뛴다. 최종 판정은 서버가 한다.
   */
  function passesUploadCheck(items: UploadItem[], whole: FileEntry[] | null, maxRepoBytes: number | null): boolean {
    const check = checkUploadPlan({
      items: items.map((item) => ({ path: item.path, size: item.source.size })),
      existing: whole ? new Map(whole.map((file) => [file.path, file.size])) : null,
      // 전체 목록이 있으면 그것이 지금 저장소 그대로이고, 없으면 화면이 가진 저장소 요약으로.
      fileCount: whole ? whole.length : (repo?.fileCount ?? 0),
      totalSize: whole ? whole.reduce((sum, file) => sum + file.size, 0) : (repo?.totalSize ?? 0),
      maxFiles: MAX_FILES_PER_REPO,
      maxRepoBytes,
    });
    const notice = describeUploadCheck(check);
    if (!notice) return true;
    notify(notice.title, notice.message, notice.tone);
    return false;
  }

  /**
   * 조각으로 나눠 올리고 커밋 하나로 반영한 뒤, 결과를 알려 준다. 올리기는 전송 스토어가 맡아 이 화면을
   * 떠나도 이어지므로, 끝난 뒤에는 토스트만 띄운다(목록은 finishedSeq 로 다시 읽는다). 시작은 동기로 일어나
   * 부른 쪽이 기다리지 않아도 바로 버튼이 막힌다.
   */
  async function runUpload(items: UploadItem[]) {
    try {
      const handle = runTransfer({
        kind: 'upload',
        repoId,
        label: '올리는 중',
        cancelMessage: '올리던 파일은 끊고, 그때까지 다 올린 파일만 저장소에 반영합니다.',
        totalFiles: items.length,
        task: (report, signal) => uploadAndCommit(repoId, items, report, signal),
      });
      const result = await handle.promise;
      // 서버를 바꿨거나 로그아웃해 그만뒀다 — 스토어가 이미 알렸다.
      if (isAbandoned(handle.signal)) return;
      const notice = describeUploadOutcome({
        total: items.length,
        uploaded: result.uploaded.length,
        failures: result.failures.map((f) => ({ name: f.item.source.name, message: f.message })),
        cancelled: result.cancelled,
        offline: result.offline,
        commit: result.commit,
      });
      if (notice) notify(notice.title, notice.message, notice.tone);
    } catch (err) {
      if (err instanceof TransferBusy) return;
      if (err instanceof CommitFailed) {
        // 다 올렸는데 커밋이 막혔다(이름 겹침·한도 따위) — 올린 파일이 저장소에 없다는 것을 분명히.
        const notice = describeCommitFailure(err.error, err.uploaded);
        notify(notice.title, notice.message, notice.tone);
      } else notifyError('반영하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    }
  }

  async function upload() {
    if (uploading || preparing || !treeFresh) return;
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
      const [limits, whole] = await Promise.all([getServerLimits(), listWholeRepo()]);
      const accepted = withinLimit(sources, limits.maxUploadBytes);
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
      if (!passesUploadCheck(changed, whole, limits.maxRepoBytes)) return;

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
      void runUpload(changed);
    } finally {
      setPreparing(false);
    }
  }

  /** 폴더를 통째로 — 폴더 구조 그대로 지금 폴더 아래에 올리고 커밋 하나로 반영한다. */
  async function uploadFolder() {
    if (uploading || preparing) return;
    let picked: PickedFolder;
    try {
      picked = await pickFolder();
    } catch {
      notifyError('폴더를 선택하지 못했습니다.');
      return;
    }
    const { sources, truncated } = picked;
    if (sources.length === 0) return;
    setPreparing(true);
    try {
      const [limits, whole] = await Promise.all([getServerLimits(), listWholeRepo()]);
      const accepted = withinLimit(sources, limits.maxUploadBytes);
      if (accepted.length === 0) return;

      const folderName = (accepted[0].relativePath ?? accepted[0].name).split('/')[0];
      const items = accepted.map((source) => {
        const inner = source.relativePath ?? source.name;
        return { source, path: path ? `${path}/${inner}` : inner };
      });
      // 멈췄다가 같은 폴더를 다시 올리면, 이미 올라간 그대로인 파일은 다시 보내지 않는다.
      // 전체 목록을 받았으면 그것으로(경로가 저장소 전체 기준이라 그대로 견준다), 아니면 그 폴더만 따로 훑는다.
      let remote: RemoteFiles = new Map();
      try {
        remote = remoteFilesOf(whole ?? (await listRepoFolder(repoId, path ? `${path}/${folderName}` : folderName)));
      } catch {
        // 못 받으면 전부 올린다 — 서버가 내용이 같은 파일은 반영하지 않는다.
      }
      const { changed, unchanged } = splitUnchanged(items, remote);
      if (changed.length === 0) {
        notify(`'${folderName}' 은(는) 모두 이미 올라가 있습니다.`, `파일 ${unchanged.length}개가 저장소에 그대로 있습니다.`);
        return;
      }
      if (!passesUploadCheck(changed, whole, limits.maxRepoBytes)) return;

      const totalBytes = changed.reduce((sum, item) => sum + item.source.size, 0);
      const ok = await confirmAction({
        title: `'${folderName}' 폴더를 올릴까요?`,
        message:
          `파일 ${changed.length}개 · ${formatBytes(totalBytes)}\n` +
          (truncated ? `${TRUNCATED_NOTE}\n` : '') +
          (unchanged.length > 0 ? `이미 올라가 있는 ${unchanged.length}개는 건너뜁니다.\n` : '') +
          `${path ? `'${path}' 아래에` : '저장소 맨 위에'} 폴더 구조 그대로 올립니다. 같은 경로의 파일은 새 내용으로 바뀌고, 이전 버전은 변경 이력에 남습니다.`,
        confirmLabel: '올리기',
      });
      if (!ok) return;
      void runUpload(changed);
    } finally {
      setPreparing(false);
    }
  }

  /** 파일 하나, 또는 폴더를 zip 으로 받는다. */
  async function download(targetPath: string, fileName: string, archive = false) {
    // 받는 중에 다른 행(검색 결과 포함)을 또 누르면 같은 캐시 파일을 덮어쓰거나 선택기가 두 번 뜬다.
    if (busyPath !== null) return;
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

    // 파일이면 지운 내용을 알고 있어 바로 되돌릴 수 있다. 폴더는 휴지통에서.
    const file = isFolder ? undefined : files.find((entry) => entry.path === targetPath);
    setBusyPath(targetPath);
    try {
      await api.deletePath(repoId, targetPath);
      if (file) offerUndo('지웠습니다.', [{ path: file.path, blobHash: null, expect: file.blobHash }], `삭제: ${file.path}`);
      else notify('지웠습니다.', '변경 이력 → 휴지통에서 되돌릴 수 있습니다.');
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
    const from = editing.path;
    try {
      await api.movePath(repoId, from, to);
      setEditing(null);
      // 다른 폴더로 옮기면 목록에서 말없이 사라졌다 — 어디로 갔는지 알리고 바로 무를 길을 준다.
      const sameFolder = parentPath(from) === parentPath(to);
      offerUndoWith(sameFolder ? '이름을 바꿨습니다.' : '옮겼습니다.', `${from} → ${to}`, async () => {
        await api.movePath(repoId, to, from);
      });
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
              {/* 개수·용량은 현재(head) 값이라 과거 시점 보기에서는 틀리므로 숨긴다. */}
              {snapshotId ? null : <Caption>파일 {repo.fileCount}개</Caption>}
              {snapshotId ? null : <Caption>{formatBytes(repo.totalSize)}</Caption>}
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
                  disabled={preparing || !treeFresh}
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

          {!isEditor && !snapshotId ? (
            <Caption>
              열람 권한이라 파일을 직접 바꿀 수는 없지만, 변경 제안을 올리면 편집자가 검토 후
              반영합니다.
            </Caption>
          ) : null}

          <Input
            value={query}
            onChangeText={setQuery}
            placeholder={shortcutsSupported ? '저장소 전체에서 파일 찾기 ( / )' : '저장소 전체에서 파일 찾기'}
            accessibilityLabel="파일 찾기"
            ref={searchRef}
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
              onOpenFolder={(folder, filePath) => {
                setQuery('');
                openFolder(folder);
                setHighlight(filePath);
              }}
              onVersions={snapshotId ? undefined : openVersions}
            />
          ) : (
            <>
              <Breadcrumb path={path} onNavigate={openFolder} />
              {!state.loading && tree.dirs.length + tree.files.length > 1 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
                  <SortBar order={sort} onChange={setSort} />
                  {tree.files.length > 1 && !selecting ? (
                    <Button
                      label="여러 개 고르기"
                      icon="checkbox-outline"
                      variant="ghost"
                      compact
                      onPress={() => {
                        setMenuPath(null);
                        setEditing(null);
                        setSelecting(true);
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              {selecting && !state.loading ? (
                <View
                  style={{
                    backgroundColor: colors.accentSoft,
                    borderRadius: radius.md,
                    padding: spacing.md,
                    gap: spacing.sm,
                  }}
                >
                  <Row style={{ justifyContent: 'space-between' }} wrap>
                    <Body style={{ fontWeight: '600', color: colors.accent }}>
                      {chosen.length > 0 ? `${chosen.length}개 고름` : '받거나 지울 파일을 누르세요'}
                    </Body>
                    <Row gap={spacing.xs}>
                      <Button
                        label={chosen.length === files.length ? '선택 풀기' : '전부 선택'}
                        variant="ghost"
                        compact
                        onPress={() =>
                          setSelected(chosen.length === files.length ? new Set() : new Set(files.map((file) => file.path)))
                        }
                      />
                      <Button label="끝내기" variant="ghost" compact onPress={stopSelecting} />
                    </Row>
                  </Row>
                  <Row gap={spacing.sm} wrap>
                    <Button
                      label={`고른 파일 ${chosen.length}개 받기`}
                      icon="download-outline"
                      variant="secondary"
                      compact
                      onPress={() => void downloadSelected()}
                      disabled={chosen.length === 0 || bulkBusy}
                      loading={bulkBusy}
                    />
                    {canEdit ? (
                      <Button
                        label={`고른 파일 ${chosen.length}개 옮기기`}
                        icon="arrow-redo-outline"
                        variant="secondary"
                        compact
                        onPress={() => setMoveTarget((prev) => (prev === null ? path : null))}
                        disabled={chosen.length === 0 || bulkBusy}
                      />
                    ) : null}
                    {canEdit ? (
                      <Button
                        label={`고른 파일 ${chosen.length}개 지우기`}
                        icon="trash-outline"
                        variant="danger"
                        compact
                        onPress={() => void deleteSelected()}
                        disabled={chosen.length === 0 || bulkBusy}
                      />
                    ) : null}
                  </Row>
                  {moveTarget !== null && canEdit ? (
                    <View style={{ gap: spacing.sm }}>
                      <Input
                        value={moveTarget}
                        onChangeText={setMoveTarget}
                        autoFocus
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="폴더 경로 (비우면 맨 위, 예: 보관/2024)"
                        accessibilityLabel="옮길 폴더"
                        onSubmitEditing={() => void moveSelected()}
                        style={{ fontFamily: monoFont, fontSize: fontSize.sm }}
                      />
                      <Caption>없는 폴더면 새로 만들어집니다. 변경 이력에는 한 번으로 남습니다.</Caption>
                      <Row gap={spacing.sm} style={{ justifyContent: 'flex-end' }}>
                        <Button label="취소" variant="ghost" compact onPress={() => setMoveTarget(null)} disabled={bulkBusy} />
                        <Button
                          label="여기로 옮기기"
                          compact
                          onPress={() => void moveSelected()}
                          loading={bulkBusy}
                          disabled={chosen.length === 0}
                        />
                      </Row>
                    </View>
                  ) : null}
                </View>
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
                            ? CAN_PICK_FOLDER
                              ? '이 기기의 파일이나 폴더를 올리면 여기에 표시됩니다. 올린 파일은 멤버 모두가 내려받을 수 있습니다.'
                              : '이 기기의 파일을 올리면 여기에 표시됩니다. 올린 파일은 멤버 모두가 내려받을 수 있습니다.'
                            : '편집 권한이 있는 멤버가 파일을 올리면 여기에 표시됩니다. 올리고 싶은 파일이 있으면 변경 제안으로 보내세요.'
                      }
                      action={
                        // 위 버튼(「파일 올리기」·「변경 제안 만들기」)과 이름이 겹치지 않게 — e2e 가 이름 일부로 찾는다.
                        snapshotId || path !== '' ? undefined : canEdit ? (
                          <Button
                            label="올릴 파일 고르기"
                            icon="cloud-upload-outline"
                            onPress={upload}
                            disabled={uploading || preparing || !treeFresh}
                          />
                        ) : (
                          <Button
                            label="제안으로 파일 보내기"
                            icon="git-pull-request-outline"
                            variant="secondary"
                            onPress={() => router.push(`/repo/${repoId}/new-proposal?path=${encodeURIComponent(path)}`)}
                          />
                        )
                      }
                    />
                  ) : (
                    <>
                      {dirs.map((dir, index) => (
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
                              <IconButton
                                icon="ellipsis-horizontal"
                                label={`${dir.name} 폴더 더보기`}
                                expanded={menuPath === dir.path}
                                onPress={() => toggleMenu(dir.path)}
                              />
                              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                            </Pressable>
                          )}
                          {menuPath === dir.path && editing?.path !== dir.path ? (
                            <RowMenu>
                              <Button
                                label="경로 복사"
                                accessibilityLabel={`${dir.name} 폴더 경로 복사`}
                                icon="copy-outline"
                                variant="secondary"
                                compact
                                onPress={fromMenu(() => void copyPath(dir.path))}
                              />
                              {canEdit ? (
                                <>
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
                                </>
                              ) : null}
                            </RowMenu>
                          ) : null}
                        </View>
                      ))}

                      {files.map((file, index) => (
                        <View key={file.path}>
                          {index > 0 || dirs.length > 0 ? <Divider /> : null}
                          {editing?.path === file.path ? (
                            <RenameRow
                              icon={iconForMime(file.mimeType)}
                              value={editing.value}
                              busy={renaming}
                              hint="전체 경로입니다. 앞의 폴더 부분을 지우면 맨 위로 옮겨집니다."
                              onChange={(value) => setEditing({ ...editing, value })}
                              onConfirm={() => void confirmRename()}
                              onCancel={() => setEditing(null)}
                            />
                          ) : selecting ? (
                            <Pressable
                              onPress={() => toggleSelected(file.path)}
                              accessibilityRole="checkbox"
                              aria-checked={selected.has(file.path)}
                              accessibilityLabel={`${file.name} 고르기`}
                              style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: spacing.md,
                                paddingVertical: spacing.md,
                                paddingHorizontal: spacing.lg,
                                backgroundColor: selected.has(file.path) ? colors.accentSoft : pressed ? colors.surfaceAlt : 'transparent',
                              })}
                            >
                              <Ionicons
                                name={selected.has(file.path) ? 'checkbox' : 'square-outline'}
                                size={20}
                                color={selected.has(file.path) ? colors.accent : colors.textMuted}
                              />
                              <View style={{ flex: 1 }}>
                                <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.text, fontSize: fontSize.md }}>
                                  {file.name}
                                </Text>
                                <Caption>
                                  {formatBytes(file.size)} · {formatRelativeTime(file.updatedAt)}
                                </Caption>
                              </View>
                            </Pressable>
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
                                backgroundColor: pressed
                                  ? colors.surfaceAlt
                                  : highlight === file.path
                                    ? colors.accentSoft
                                    : 'transparent',
                              })}
                              // 찾기 결과에서 「있는 폴더 열기」로 왔으면 그 줄을 잠시 칠하고 화면 안으로(웹).
                              ref={highlight === file.path ? scrollIntoViewOnWeb : undefined}
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
                                  <IconButton
                                    icon="ellipsis-horizontal"
                                    label={`${file.name} 더보기`}
                                    expanded={menuPath === file.path}
                                    onPress={() => toggleMenu(file.path)}
                                  />
                                </>
                              )}
                            </Pressable>
                          )}
                          {menuPath === file.path && editing?.path !== file.path && !selecting ? (
                            <RowMenu>
                              <Button
                                label="경로 복사"
                                accessibilityLabel={`${file.name} 경로 복사`}
                                icon="copy-outline"
                                variant="secondary"
                                compact
                                onPress={fromMenu(() => void copyPath(file.path))}
                              />
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

const SORT_LABEL: Record<SortKey, string> = { name: '이름', size: '크기', updated: '최근' };
const SORT_KEYS: SortKey[] = ['name', 'size', 'updated'];

/**
 * 정렬 칩 — 누르면 그 기준으로, 이미 그 기준이면 방향을 뒤집는다. 폴더는 늘 위(lib/pure/file-sort.ts).
 * 화살표는 지금 방향(위 = 작은 것·가나다·오래된 것부터).
 */
function SortBar({ order, onChange }: { order: SortOrder; onChange: (order: SortOrder) => void }) {
  const { colors } = useTheme();
  const direction = (key: SortKey, desc: boolean) =>
    key === 'name' ? (desc ? '가나다 거꾸로' : '가나다순') : key === 'size' ? (desc ? '큰 것부터' : '작은 것부터') : desc ? '새것부터' : '오래된 것부터';
  return (
    <View
      role="toolbar"
      aria-label="정렬"
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}
    >
      <Caption>정렬</Caption>
      {SORT_KEYS.map((key) => {
        const active = order.key === key;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(nextSortOrder(order, key))}
            accessibilityRole="button"
            accessibilityLabel={`${SORT_LABEL[key]}순 정렬${active ? `, 지금 ${direction(key, order.desc)}` : ''}`}
            aria-pressed={active}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              paddingVertical: spacing.xs,
              paddingHorizontal: spacing.md,
              borderRadius: radius.pill,
              backgroundColor: active ? colors.accentSoft : colors.surfaceAlt,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ color: active ? colors.accent : colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' }}>
              {SORT_LABEL[key]}
            </Text>
            {active ? (
              <Ionicons name={order.desc ? 'arrow-down' : 'arrow-up'} size={13} color={colors.accent} />
            ) : null}
          </Pressable>
        );
      })}
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
