import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { formatBytes, formatRelativeTime, hasRole, type RepoSummary } from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { TransferProgress } from '../../../src/components/TransferProgress';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notify, notifySuccess, notifyWarning } from '../../../src/lib/dialogs';
import { HashAbortedError } from '../../../src/lib/hash';
import {
  forgetFolder,
  localFolderSupported,
  openFolderRef,
  pickLocalFolder,
  rememberFolder,
  type LocalFolder,
} from '../../../src/lib/local-folder';
import { resolveConflict, type ConflictReason, type SyncAction } from '../../../src/lib/sync-plan';
import {
  applySync,
  checkSync,
  describeOutcome,
  isSyncRunning,
  loadSyncState,
  safeActions,
  saveSyncState,
  subscribeSync,
  withSyncLock,
  type SyncScan,
  type SyncState,
} from '../../../src/lib/sync-run';
import type { UploadProgress } from '../../../src/lib/transfer';
import { useAbortable } from '../../../src/lib/useAbortable';
import { useAuth } from '../../../src/state/auth';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

const CONFLICT_TEXT: Record<ConflictReason, string> = {
  'both-changed': '양쪽에서 다르게 바뀜',
  'changed-deleted': '내 폴더에서 바꿨는데 저장소에서는 지워짐',
  'deleted-changed': '내 폴더에서 지웠는데 저장소에서는 바뀜',
  'first-differs': '처음 맞추는데 양쪽 내용이 다름',
};

type Choice = 'mine' | 'theirs' | 'skip';

/** 저장소를 바꾸지 않는 일 — 다른 서버를 따라가는 저장소(미러)에서는 이것만 한다. */
const LOCAL_ONLY_KINDS = new Set<SyncAction['kind']>(['download', 'move-local', 'delete-local']);

/**
 * 폴더 동기화 — 기기의 폴더 하나를 저장소 폴더와 맞춰 둔다. 마지막으로 맞춘 상태를 기억해 누가 무엇을 바꿨는지 가린다
 * (3-way, lib/sync-plan.ts). PC 앱·안드로이드만(브라우저는 폴더에 쓸 수 없다).
 *
 * 지우기와 충돌은 늘 사람이 고른다. 자동으로 두면 앱을 켜 둔 동안 어느 화면에 있든 1분마다 확인해 올리기·받기·옮기기만
 * 저절로 한다(lib/useAutoSync.ts). 이 화면과 자동 맞추기는 같은 잠금을 쓰므로 겹치지 않는다.
 */
export default function SyncScreen() {
  const { repoId, path: pathParam } = useLocalSearchParams<{ repoId: string; path?: string }>();
  const { colors } = useTheme();
  const { activeServer } = useAuth();
  const serverId = activeServer?.id ?? 'default';

  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [state, setState] = useState<SyncState | null | undefined>(undefined);
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const [scan, setScan] = useState<SyncScan | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [allowDeletes, setAllowDeletes] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ label: string; value: UploadProgress } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const control = useAbortable();
  const checkedOnce = useRef(false);
  const isEditor = hasRole(repo?.role, 'editor');
  const writable = !repo?.mirror;

  useEffect(() => {
    void api.getRepo(repoId).then(({ repo: summary }) => setRepo(summary), () => {});
    void loadSyncState(serverId, repoId).then(setState);
  }, [repoId, serverId]);

  const persist = useCallback(
    async (next: SyncState | null) => {
      setState(next);
      await saveSyncState(serverId, repoId, next);
    },
    [serverId, repoId],
  );

  /**
   * 기억해 둔 폴더를 열고 양쪽을 훑어 계획을 세운다. 기준만 고치면 되는 것(처음부터 같은 파일 등)은 이때 기준에 적어 둔다.
   * 자동 맞추기가 이 저장소를 돌리는 중이면 기다리지 않고 건너뛴다(끝나면 알림으로 다시 확인한다).
   */
  const check = useCallback(
    async (current: SyncState, quiet = false): Promise<{ folder: LocalFolder; scan: SyncScan; state: SyncState } | null> => {
      setError(null);
      const result = await withSyncLock(serverId, repoId, async () => {
        setWorking('check');
        const signal = control.start();
        try {
          const sameRef = folder?.ref && JSON.stringify(folder.ref) === JSON.stringify(current.ref);
          const opened = sameRef && folder.rescan ? await folder.rescan() : await openFolderRef(current.ref);
          setFolder(opened);
          const checked = await checkSync(repoId, current, opened, {
            signal,
            onHashing: (done, total, name) =>
              setProgress({ label: '내용 확인 중', value: { sentBytes: done, totalBytes: total, doneFiles: done, totalFiles: total, current: name } }),
          });
          if (checked.state !== current) await persist(checked.state);
          setScan(checked.scan);
          setChoices({});
          return { folder: opened, scan: checked.scan, state: checked.state };
        } catch (err) {
          if (!(err instanceof HashAbortedError) && !quiet) {
            setError(err instanceof ApiError || err instanceof Error ? err.message : '확인하지 못했습니다.');
          }
          return null;
        } finally {
          control.finish();
          setProgress(null);
          setWorking(null);
        }
      });
      return result;
    },
    [control, folder, persist, repoId, serverId],
  );

  async function setup() {
    setError(null);
    const picked = await pickLocalFolder().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '폴더를 고르지 못했습니다.');
      return null;
    });
    if (!picked) return;
    if (!picked.ref || !picked.save) {
      setError('이 기기에서는 폴더에 쓸 수 없어 동기화할 수 없습니다. PC 앱이나 안드로이드 앱을 쓰세요.');
      return;
    }
    await rememberFolder(picked);
    const next: SyncState = { ref: picked.ref, label: picked.label, basePath: pathParam ?? '', base: null, lastSyncAt: null, auto: false };
    setFolder(picked);
    // 아래 "들어오자마자 한 번" 효과가 겹쳐 확인하지 않게 먼저 표시해 둔다.
    checkedOnce.current = true;
    await persist(next);
    await check(next);
  }

  async function stop() {
    if (!state) return;
    const ok = await confirmAction({
      title: '동기화를 그만둘까요?',
      message: '내 폴더와 저장소의 파일은 그대로 둡니다. 맞춘 기록만 지웁니다.',
      confirmLabel: '그만두기',
      destructive: true,
    });
    if (!ok) return;
    await forgetFolder(state.ref);
    setScan(null);
    setFolder(null);
    await persist(null);
  }

  /** 계획을 실행할 일로 바꾼다 — 충돌은 고른 대로, 지우기는 허락했을 때만. */
  function actionsToRun(current: SyncScan, includeDeletes: boolean): SyncAction[] {
    const actions: SyncAction[] = [];
    for (const action of current.plan.actions) {
      if (action.kind === 'conflict') {
        const choice = choices[action.path] ?? 'skip';
        if (choice === 'skip') continue;
        const resolved = resolveConflict(action, choice, {
          local: current.local.has(action.path),
          remote: current.remote.has(action.path),
        });
        if ((resolved.kind === 'delete-local' || resolved.kind === 'delete-remote') && !includeDeletes) continue;
        actions.push(resolved);
      } else if (action.kind === 'delete-local' || action.kind === 'delete-remote') {
        if (includeDeletes) actions.push(action);
      } else if (action.kind !== 'proposed') {
        actions.push(action);
      }
    }
    // 열람자는 저장소를 바꿀 수 없으니 저장소 쪽 일은 제안으로 간다(applySync). 미러 저장소는 내 폴더 쪽 일만.
    return writable ? actions : actions.filter((action) => LOCAL_ONLY_KINDS.has(action.kind));
  }

  async function run(current: SyncState, currentScan: SyncScan, currentFolder: LocalFolder, actions: SyncAction[]) {
    setError(null);
    const ran = await withSyncLock(serverId, repoId, async () => {
      setWorking('apply');
      const signal = control.start();
      try {
        const outcome = await applySync(repoId, current, currentFolder, currentScan, actions, {
          isEditor,
          signal,
          onProgress: (label, value) => setProgress({ label, value }),
        });
        // 하다 만 것도 한 것은 기준에 적는다 — 다음에 같은 일을 되풀이하지 않게.
        const next: SyncState = { ...current, base: outcome.base, lastSyncAt: Date.now() };
        await persist(next);
        const done = describeOutcome(outcome, isEditor);
        if (outcome.cancelled) notifyWarning(done ? `멈췄습니다 — 그 전까지 ${done}` : '멈췄습니다.');
        else if (outcome.failures.length > 0) notifyWarning(done ? `일부만 맞췄습니다 — ${done}` : '맞추지 못했습니다.', outcome.failures.slice(0, 3).join('\n'));
        else if (done) {
          notifySuccess(
            `맞췄습니다 — ${done}`,
            outcome.proposalNumber ? `변경 제안 #${outcome.proposalNumber} 로 보냈습니다. 편집자가 반영하면 맞춰집니다.` : undefined,
          );
        } else notify('맞출 것이 없습니다.');
        return next;
      } finally {
        control.finish();
        setProgress(null);
        setWorking(null);
      }
    });
    if (ran === null) {
      notify('자동 맞추기가 이 저장소를 돌리는 중입니다.', '끝나면 결과를 다시 보여 줍니다.');
      return;
    }
    // 결과를 다시 보여 준다(받은 파일의 고친 시각도 이때 기준에 적힌다).
    await check(ran, true);
  }

  async function applyNow() {
    if (!state || !scan || !folder) return;
    const actions = actionsToRun(scan, allowDeletes);
    if (actions.length === 0) {
      notify('할 일이 없습니다.', '충돌은 내 것·저장소 것을 고르고, 지우기는 아래에서 허락해야 합니다.');
      return;
    }
    const deletes = actions.filter((action) => action.kind === 'delete-local' || action.kind === 'delete-remote').length;
    if (deletes > 0) {
      const ok = await confirmAction({
        title: `${deletes}개를 지웁니다`,
        message: '내 폴더에서 지우는 것은 PC 앱이면 휴지통으로 갑니다. 저장소에서 지운 것은 변경 이력에서 되돌릴 수 있습니다.',
        confirmLabel: '동기화',
        destructive: true,
      });
      if (!ok) return;
    }
    await run(state, scan, folder, actions);
  }

  // 자동 맞추기는 앱 전체에서 돈다(lib/useAutoSync.ts). 이 저장소를 다뤘으면 바뀐 상태를 읽어 다시 보여 준다.
  const latest = useRef({ state, working, check });
  latest.current = { state, working, check };
  useEffect(
    () =>
      subscribeSync((event) => {
        if (event.serverId !== serverId || event.repoId !== repoId || event.type !== 'auto-ran') return;
        void (async () => {
          const saved = await loadSyncState(serverId, repoId);
          if (!saved || latest.current.working) return;
          setState(saved);
          await latest.current.check(saved, true);
        })();
      }),
    [serverId, repoId],
  );

  // 기억해 둔 동기화가 있으면 들어오자마자 한 번 확인한다.
  useEffect(() => {
    if (state && !checkedOnce.current) {
      checkedOnce.current = true;
      void check(state);
    }
  }, [state, check]);

  if (!localFolderSupported) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '폴더 동기화' }} />
        <EmptyState icon="sync-outline" title="이 기기에서는 동기화할 수 없습니다" description="PC 앱이나 안드로이드 앱에서 해 주세요." />
      </Screen>
    );
  }

  const actions = scan?.plan.actions ?? [];
  const group = (kind: SyncAction['kind']) => actions.filter((action) => action.kind === kind);
  const conflicts = group('conflict') as Extract<SyncAction, { kind: 'conflict' }>[];
  const moves = [...group('move-remote'), ...group('move-local')] as Extract<SyncAction, { kind: 'move-remote' | 'move-local' }>[];
  const deletes = [...group('delete-remote'), ...group('delete-local')];
  const autoReady = scan ? safeActions(scan.plan, writable).length : 0;
  const runnable = scan ? actionsToRun(scan, allowDeletes).length : 0;
  const sizeOf = (path: string, side: 'local' | 'remote') =>
    side === 'local' ? (scan?.local.get(path)?.size ?? 0) : (scan?.remote.get(path)?.size ?? 0);

  return (
    <Screen>
      <Stack.Screen options={{ title: '폴더 동기화' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>폴더 동기화</Title>
        <Subtitle>
          이 기기의 폴더 하나를 저장소 폴더와 맞춰 둡니다. 마지막으로 맞춘 뒤 어느 쪽이 바뀌었는지 보고, 바뀐 쪽을 따라
          올리거나 받습니다. {isEditor ? '' : '열람 권한이라 내 쪽 변경은 변경 제안으로 보냅니다.'}
        </Subtitle>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      {state === undefined ? (
        <Loading />
      ) : state === null ? (
        <Card style={{ gap: spacing.md }}>
          <Body>
            저장소의 <Body style={{ fontFamily: monoFont }}>{pathParam ? `/${pathParam}` : '맨 위'}</Body> 와 맞출 폴더를 고르세요.
          </Body>
          <Caption>
            처음 맞출 때는 한쪽에만 있는 파일을 다른 쪽으로 채우고, 양쪽에 있는데 내용이 다르면 고르게 합니다. 처음에는 아무것도
            지우지 않습니다.
          </Caption>
          <Button label="폴더 고르기" icon="folder-open-outline" onPress={() => void setup()} />
        </Card>
      ) : (
        <>
          <Card style={{ gap: spacing.md }}>
            <View style={{ gap: 2 }}>
              <Caption>내 폴더</Caption>
              <Body numberOfLines={2} style={{ fontFamily: monoFont }}>
                {state.label}
              </Body>
              <Caption style={{ fontFamily: monoFont }}>↔ 저장소 {state.basePath ? `/${state.basePath}` : '(맨 위)'}</Caption>
              <Caption>
                {state.lastSyncAt ? `마지막으로 맞춤: ${formatRelativeTime(state.lastSyncAt)}` : '아직 맞추지 않았습니다.'}
              </Caption>
            </View>
            <Row gap={spacing.sm} wrap>
              <Button
                label="지금 확인"
                icon="refresh"
                variant="secondary"
                loading={working === 'check'}
                disabled={working !== null || isSyncRunning(serverId, repoId)}
                onPress={() => void check(state)}
              />
              <Button label="동기화 그만두기" variant="ghost" disabled={working !== null} onPress={() => void stop()} />
            </Row>
            {state.base ? (
              <Pressable
                onPress={() => void persist({ ...state, auto: !state.auto })}
                accessibilityRole="switch"
                aria-checked={state.auto}
                accessibilityLabel="자동으로 맞추기"
                style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Body>자동으로 맞추기</Body>
                  <Caption>앱을 켜 둔 동안 어느 화면에 있든 1분마다 확인해 올리기·받기·옮기기를 저절로 합니다. 지우기와 충돌은 기다립니다.</Caption>
                </View>
                <Switch
                  value={state.auto}
                  onValueChange={(auto) => void persist({ ...state, auto })}
                  trackColor={{ true: colors.accent, false: colors.border }}
                  aria-hidden
                />
              </Pressable>
            ) : null}
          </Card>

          {progress ? (
            <TransferProgress
              progress={progress.value}
              label={progress.label}
              onCancel={control.cancel}
              cancelling={control.cancelling}
            />
          ) : null}

          {scan ? (
            actions.length === 0 ? (
              <Card>
                <EmptyState icon="checkmark-done-outline" title="맞춰져 있습니다" description="내 폴더와 저장소가 같습니다." />
              </Card>
            ) : (
              <>
                <ActionGroup title={isEditor ? '올릴 것' : '변경 제안으로 보낼 것'} icon="cloud-upload-outline" paths={group('upload').map((a) => a.path)} size={(p) => sizeOf(p, 'local')} />
                <ActionGroup title="받을 것" icon="cloud-download-outline" paths={group('download').map((a) => a.path)} size={(p) => sizeOf(p, 'remote')} />
                <ActionGroup
                  title={isEditor || !writable ? '옮길 것' : '옮기기로 제안할 것'}
                  icon="swap-horizontal-outline"
                  paths={moves.map((a) => `${a.from} → ${a.path}${a.kind === 'move-local' ? '  (내 폴더에서)' : ''}`)}
                />
                <ActionGroup title="제안해 두고 반영을 기다리는 것" icon="hourglass-outline" paths={group('proposed').map((a) => a.path)} muted />
                {deletes.length > 0 ? (
                  <Card style={{ gap: spacing.sm }}>
                    <Row gap={spacing.sm}>
                      <Ionicons name="trash-outline" size={18} color={colors.danger} />
                      <Body style={{ fontWeight: '600', flex: 1 }}>지울 것 {deletes.length}</Body>
                    </Row>
                    {deletes.map((action) => (
                      <Caption key={action.path} style={{ fontFamily: monoFont }}>
                        {action.kind === 'delete-remote' ? '저장소에서: ' : '내 폴더에서: '}
                        {action.path}
                      </Caption>
                    ))}
                    <Pressable
                      onPress={() => setAllowDeletes(!allowDeletes)}
                      accessibilityRole="checkbox"
                      aria-checked={allowDeletes}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
                    >
                      <Ionicons name={allowDeletes ? 'checkbox' : 'square-outline'} size={20} color={allowDeletes ? colors.accent : colors.textMuted} />
                      <Body style={{ flex: 1 }}>이번에 지우기도 하기</Body>
                    </Pressable>
                    <Caption>
                      한쪽에서 지운 파일을 다른 쪽에서도 지웁니다. 내 폴더에서는 휴지통으로 가고(PC 앱), 저장소에서 지운 것은 변경
                      이력에서 되돌릴 수 있습니다.
                    </Caption>
                  </Card>
                ) : null}
                {conflicts.length > 0 ? (
                  <Card style={{ gap: spacing.sm, backgroundColor: colors.warningSoft }}>
                    <Row gap={spacing.sm}>
                      <Ionicons name="warning-outline" size={18} color={colors.warning} />
                      <Body style={{ fontWeight: '600', flex: 1, color: colors.warning }}>고를 것 {conflicts.length}</Body>
                    </Row>
                    {conflicts.map((conflict) => (
                      <View key={conflict.path} style={{ gap: spacing.xs, paddingVertical: spacing.xs }}>
                        <Body style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>{conflict.path}</Body>
                        <Caption>{CONFLICT_TEXT[conflict.reason]}</Caption>
                        <Row gap={spacing.xs} wrap>
                          {(['mine', 'theirs', 'skip'] as Choice[]).map((choice) => {
                            const active = (choices[conflict.path] ?? 'skip') === choice;
                            const label =
                              choice === 'mine' ? '내 폴더 것으로' : choice === 'theirs' ? '저장소 것으로' : '이번엔 두기';
                            return (
                              <Pressable
                                key={choice}
                                onPress={() => setChoices((prev) => ({ ...prev, [conflict.path]: choice }))}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`${conflict.path}: ${label}`}
                                style={{
                                  paddingHorizontal: spacing.md,
                                  paddingVertical: spacing.xs + 2,
                                  borderRadius: radius.pill,
                                  borderWidth: 1,
                                  borderColor: active ? colors.accent : colors.border,
                                  backgroundColor: active ? colors.accentSoft : colors.surface,
                                }}
                              >
                                <Caption style={{ color: active ? colors.accent : colors.textMuted, fontWeight: active ? '600' : '400' }}>{label}</Caption>
                              </Pressable>
                            );
                          })}
                        </Row>
                      </View>
                    ))}
                  </Card>
                ) : null}
                <Button
                  label={runnable > 0 ? `동기화 (${runnable}개)` : '할 일을 고르세요'}
                  icon="sync-outline"
                  full
                  loading={working === 'apply'}
                  disabled={runnable === 0 || working !== null}
                  onPress={() => void applyNow()}
                />
                {!writable ? <Caption>다른 서버를 따라가는 저장소라 내 폴더 쪽만 바꿉니다(받기·옮기기·지우기).</Caption> : null}
                {state.auto && autoReady === 0 && (deletes.length > 0 || conflicts.length > 0) ? (
                  <Caption>지우기나 충돌이 있어 자동으로는 맞추지 않습니다. 여기서 고르고 동기화를 누르세요.</Caption>
                ) : null}
              </>
            )
          ) : working === 'check' ? null : (
            <Caption>"지금 확인"을 누르면 맞출 것을 보여 줍니다.</Caption>
          )}
        </>
      )}
    </Screen>
  );
}

function ActionGroup({
  title,
  icon,
  paths,
  size,
  muted,
}: {
  title: string;
  icon: 'cloud-upload-outline' | 'cloud-download-outline' | 'hourglass-outline' | 'swap-horizontal-outline';
  paths: string[];
  size?: (path: string) => number;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  if (paths.length === 0) return null;
  const total = size ? paths.reduce((sum, path) => sum + size(path), 0) : 0;
  const shown = open ? paths : paths.slice(0, 5);
  return (
    <Card padded={false} style={{ paddingVertical: spacing.sm }}>
      <Row gap={spacing.sm} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
        <Ionicons name={icon} size={18} color={muted ? colors.textMuted : colors.accent} />
        <Body style={{ fontWeight: '600', flex: 1 }}>
          {title} {paths.length}
        </Body>
        {size ? <Badge label={formatBytes(total)} tone="neutral" /> : null}
      </Row>
      {shown.map((path) => (
        <View key={path}>
          <Divider />
          <Caption style={{ fontFamily: monoFont, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs }} numberOfLines={1}>
            {path}
          </Caption>
        </View>
      ))}
      {paths.length > 5 ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xs }}>
          <Button label={open ? '접기' : `${paths.length - 5}개 더 보기`} variant="ghost" compact onPress={() => setOpen(!open)} />
        </View>
      ) : null}
    </Card>
  );
}
