import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';
import {
  MAX_TRASH_ENTRIES,
  formatBytes,
  formatRelativeTime,
  hasRole,
  type RepoSummary,
  type TrashEntry,
} from '@listup/shared';
import {
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
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notify, notifyError, notifySuccess } from '../../../src/lib/dialogs';
import { downloadFromRepo } from '../../../src/lib/files';
import { MISSING_FEATURE_MESSAGE, isMissingFeature, restoreFiles } from '../../../src/lib/restore';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, spacing, useTheme } from '../../../src/theme';

/** 묶음 하나에 처음 보여 주는 파일 수. 폴더를 통째로 지운 묶음은 길다. */
const SHOWN_PER_GROUP = 5;

interface TrashView {
  repo: RepoSummary;
  entries: TrashEntry[];
  missing: boolean;
}

/** 같은 때(같은 스냅샷) 지운 파일들. */
interface Group {
  snapshotId: string;
  message: string;
  deletedAt: number;
  deletedBy: string;
  entries: TrashEntry[];
}

/**
 * 휴지통 — 지워서 지금 저장소에 없는 파일. 지운 내용은 이력에 남아 있어 언제든 되돌릴 수 있다.
 * 같은 때 지운 것(폴더 삭제 등)은 한 묶음으로 보여 주고 한 번에 되돌린다.
 */
export default function TrashScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const state = useAsync<TrashView>(async () => {
    const { repo } = await api.getRepo(repoId);
    try {
      const { entries } = await api.trash(repoId);
      return { repo, entries, missing: false };
    } catch (err) {
      if (isMissingFeature(err)) return { repo, entries: [], missing: true };
      throw err;
    }
  }, [repoId]);

  const isEditor = hasRole(state.data?.repo.role, 'editor');
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const entry of state.data?.entries ?? []) {
      const last = out[out.length - 1];
      if (last && last.snapshotId === entry.snapshotId) last.entries.push(entry);
      else {
        out.push({
          snapshotId: entry.snapshotId,
          message: entry.message,
          deletedAt: entry.deletedAt,
          deletedBy: entry.deletedBy.displayName,
          entries: [entry],
        });
      }
    }
    return out;
  }, [state.data]);

  async function restore(entries: TrashEntry[], key: string) {
    if (busy) return;
    const one = entries.length === 1;
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const ok = await confirmAction({
      title: isEditor
        ? one ? '이 파일을 되돌릴까요?' : `${entries.length}개를 되돌릴까요?`
        : '되돌리자고 제안할까요?',
      message:
        (one ? entries[0].path : `${entries.slice(0, 3).map((e) => e.path).join('\n')}${entries.length > 3 ? `\n외 ${entries.length - 3}개` : ''}`) +
        `\n${formatBytes(total)} · 지우기 전 내용 그대로 원래 경로에 다시 둡니다.` +
        (isEditor ? '' : '\n열람 권한이라 변경 제안을 만들고, 편집자가 확인한 뒤 반영합니다.'),
      confirmLabel: isEditor ? '되돌리기' : '제안 만들기',
    });
    if (!ok) return;
    setBusy(key);
    try {
      const result = await restoreFiles(
        repoId,
        entries.map((entry) => ({ path: entry.path, blobHash: entry.blobHash })),
        {
          isEditor,
          message: (one ? `휴지통에서 되돌림: ${entries[0].path}` : `휴지통에서 ${entries.length}개 되돌림`).slice(0, 200),
        },
      );
      if (result.kind === 'proposal') {
        router.push(`/proposal/${result.proposalId}`);
        return;
      }
      notifySuccess(one ? `${entries[0].name} 을(를) 되돌렸습니다.` : `${entries.length}개를 되돌렸습니다.`);
      state.refresh();
    } catch (err) {
      notifyError('되돌리지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function download(entry: TrashEntry) {
    if (busy) return;
    const key = `dl:${entry.snapshotId}:${entry.path}`;
    setBusy(key);
    try {
      // 지우기 바로 전 시점에는 그 파일이 있다.
      const result = await downloadFromRepo(repoId, {
        path: entry.path,
        snapshotId: entry.beforeSnapshotId,
        fileName: entry.name,
      });
      if (result.message) notify(result.message);
    } catch (err) {
      notifyError('내려받지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (snapshotId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(snapshotId)) next.delete(snapshotId);
      else next.add(snapshotId);
      return next;
    });

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />
      }
    >
      <Stack.Screen options={{ title: '휴지통' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>휴지통</Title>
        <Subtitle>
          지워서 지금 저장소에 없는 파일입니다. 지운 내용은 변경 이력에 남아 있어 언제든 원래 자리로 되돌릴 수
          있습니다. 이름을 바꾸거나 옮긴 파일은 여기에 나오지 않습니다.
        </Subtitle>
      </View>

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data?.missing ? (
        <ErrorNotice message={MISSING_FEATURE_MESSAGE} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon="trash-outline" title="휴지통이 비어 있습니다" description="지운 파일이 여기에 모입니다." />
        </Card>
      ) : (
        <>
          {groups.map((group) => {
            const open = expanded.has(group.snapshotId);
            const shown = open ? group.entries : group.entries.slice(0, SHOWN_PER_GROUP);
            const hidden = group.entries.length - shown.length;
            return (
              <Card key={group.snapshotId} padded={false}>
                <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                  <Body style={{ fontWeight: '600' }}>{group.message || '삭제'}</Body>
                  <Row gap={spacing.md} wrap>
                    <Caption>{group.deletedBy}</Caption>
                    <Caption>{formatRelativeTime(group.deletedAt)}</Caption>
                    <Caption>
                      {group.entries.length}개 · {formatBytes(group.entries.reduce((sum, e) => sum + e.size, 0))}
                    </Caption>
                  </Row>
                  {group.entries.length > 1 ? (
                    <Button
                      label={isEditor ? `${group.entries.length}개 모두 되돌리기` : `${group.entries.length}개 되돌리기 제안`}
                      icon="arrow-undo-outline"
                      variant="secondary"
                      compact
                      loading={busy === group.snapshotId}
                      disabled={busy !== null}
                      onPress={() => void restore(group.entries, group.snapshotId)}
                    />
                  ) : null}
                </View>
                {shown.map((entry) => {
                  const key = `${entry.snapshotId}:${entry.path}`;
                  return (
                    <View key={key}>
                      <Divider />
                      <Row gap={spacing.md} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>
                        <Ionicons name="document-outline" size={20} color={colors.textMuted} />
                        <View style={{ flex: 1 }}>
                          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.text, fontSize: fontSize.md }}>
                            {entry.name}
                          </Text>
                          <Caption numberOfLines={1}>
                            {entry.path} · {formatBytes(entry.size)}
                          </Caption>
                        </View>
                        <IconButton
                          icon="download-outline"
                          label={`${entry.name} 지우기 전 내용 받기`}
                          onPress={() => void download(entry)}
                        />
                        <IconButton
                          icon="arrow-undo-outline"
                          label={`${entry.name} 되돌리기`}
                          onPress={() => void restore([entry], key)}
                        />
                      </Row>
                    </View>
                  );
                })}
                {hidden > 0 || (open && group.entries.length > SHOWN_PER_GROUP) ? (
                  <>
                    <Divider />
                    <View style={{ padding: spacing.sm }}>
                      <Button
                        label={open ? '접기' : `${hidden}개 더 보기`}
                        icon={open ? 'chevron-up' : 'chevron-down'}
                        variant="ghost"
                        compact
                        full
                        onPress={() => toggle(group.snapshotId)}
                      />
                    </View>
                  </>
                ) : null}
              </Card>
            );
          })}
          {state.data && state.data.entries.length >= MAX_TRASH_ENTRIES ? (
            <Caption>최근 지운 {MAX_TRASH_ENTRIES}개까지 보여 줍니다. 더 오래된 것은 변경 이력의 과거 시점에서 받을 수 있습니다.</Caption>
          ) : null}
        </>
      )}
    </Screen>
  );
}
