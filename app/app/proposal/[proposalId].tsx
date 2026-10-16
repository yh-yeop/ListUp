import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, View } from 'react-native';
import {
  CHANGE_OP_LABEL,
  PROPOSAL_STATUS_LABEL,
  baseName,
  formatBytes,
  formatRelativeTime,
  hasRole,
  type ConflictResolution,
  type ProposalChange,
  type ProposalDetail,
  type ProposalStatus,
  type RepoSummary,
} from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  ErrorNotice,
  Field,
  Input,
  Loading,
  Row,
  Screen,
  Title,
} from '../../src/components/ui';
import { ApiError, api } from '../../src/api/client';
import { confirmAction, notifyError, notifySuccess } from '../../src/lib/dialogs';
import { downloadFile } from '../../src/lib/files';
import { useAsync } from '../../src/lib/useAsync';
import { LEVEL_1_4, useServerLevel } from '../../src/lib/useServerLevel';
import { useAuth } from '../../src/state/auth';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../src/theme';

interface ProposalView {
  proposal: ProposalDetail;
  repo: RepoSummary;
}

export default function ProposalDetailScreen() {
  const { proposalId } = useLocalSearchParams<{ proposalId: string }>();
  const { colors } = useTheme();
  const { user } = useAuth();
  const [comment, setComment] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 충돌마다 고른 정리 방법. 자동으로 합칠 수 있는 것은 처음부터 합치기로 골라 둔다. */
  const [choices, setChoices] = useState<Record<string, ConflictResolution>>({});
  const serverLevel = useServerLevel();

  const state = useAsync<ProposalView>(async () => {
    const { proposal } = await api.getProposal(proposalId);
    const { repo } = await api.getRepo(proposal.repoId);
    return { proposal, repo };
  }, [proposalId]);

  const proposal = state.data?.proposal;
  const repo = state.data?.repo;
  const canMerge = hasRole(repo?.role, 'editor');
  // 닫기·다시 열기는 서버 규칙대로 작성자 본인 또는 editor 이상만.
  const canManage = canMerge || (!!proposal && !!user && user.id === proposal.author.id);

  async function run(name: string, fn: () => Promise<unknown>) {
    setAction(name);
    setActionError(null);
    try {
      await fn();
      state.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const conflicts = err.conflicts;
        setActionError(
          conflicts.length > 0
            ? `${err.message}\n충돌한 파일: ${conflicts.join(', ')}`
            : err.message,
        );
      } else {
        setActionError('요청을 처리하지 못했습니다.');
      }
    } finally {
      setAction(null);
    }
  }

  async function merge() {
    if (!proposal) return;
    const ok = await confirmAction({
      title: '이 제안을 반영할까요?',
      message: `${proposal.changes.length}개 파일이 저장소에 적용됩니다. 변경 이력에 남으므로 이전 버전은 그대로 볼 수 있습니다.`,
      confirmLabel: '반영하기',
    });
    if (!ok) return;
    await run('merge', () => api.mergeProposal(proposal.id));
  }

  async function close() {
    if (!proposal) return;
    const ok = await confirmAction({
      title: '이 제안을 닫을까요?',
      message: '닫아도 나중에 다시 열 수 있습니다.',
      confirmLabel: '닫기',
    });
    if (!ok) return;
    await run('close', () => api.closeProposal(proposal.id));
  }

  const conflictDetails = proposal?.status === 'open' ? (proposal.conflictDetails ?? []) : [];
  // 충돌 정리는 1.4.0 서버부터. 작성자 본인이나 편집자.
  const canResolve = canManage && serverLevel >= LEVEL_1_4 && conflictDetails.length > 0;
  const chosen = (path: string, reason: 'changed' | 'name', autoMerge?: boolean): ConflictResolution | undefined =>
    choices[path] ?? (reason === 'name' ? 'theirs' : autoMerge ? 'merge' : undefined);
  const allChosen = conflictDetails.every((c) => chosen(c.path, c.reason, c.autoMerge) !== undefined);

  async function resolveConflicts(mergeAfter: boolean) {
    if (!proposal) return;
    const resolutions: Record<string, ConflictResolution> = {};
    for (const c of conflictDetails) {
      resolutions[c.path] = mergeAfter ? 'theirs' : chosen(c.path, c.reason, c.autoMerge)!;
    }
    const keeps = proposal.changes.length - (mergeAfter ? conflictDetails.length : Object.values(resolutions).filter((r) => r === 'theirs').length);
    const ok = await confirmAction(
      mergeAfter
        ? {
            title: '충돌 난 파일만 빼고 반영할까요?',
            message: `${conflictDetails.length}개는 저장소 내용을 그대로 두고, 나머지 ${keeps}개를 반영합니다.`,
            confirmLabel: '빼고 반영하기',
          }
        : {
            title: '고른 대로 정리할까요?',
            message:
              '정리하면 이 제안의 기준이 지금 저장소로 바뀌고, 무엇을 골랐는지 의견에 남습니다.' +
              (keeps === 0 ? '\n모두 저장소 내용을 고르면 이 제안에는 바꿀 파일이 남지 않습니다.' : ''),
            confirmLabel: '정리하기',
          },
    );
    if (!ok) return;
    await run(mergeAfter ? 'resolve-merge' : 'resolve', async () => {
      const { proposal: resolved } = await api.resolveProposal(proposal.id, resolutions);
      setChoices({});
      if (mergeAfter && resolved.changes.length > 0) await api.mergeProposal(proposal.id);
      notifySuccess(mergeAfter ? '충돌 난 파일을 빼고 반영했습니다.' : '충돌을 정리했습니다.');
    });
  }

  async function submitComment() {
    if (!proposal || !comment.trim()) return;
    await run('comment', async () => {
      await api.commentOnProposal(proposal.id, comment.trim());
      setComment('');
    });
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
      <Stack.Screen options={{ title: proposal ? `제안 #${proposal.number}` : '변경 제안' }} />

      {state.loading && !proposal ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : proposal && repo ? (
        <>
          <View style={{ gap: spacing.sm }}>
            <Row gap={spacing.sm}>
              <Badge
                label={PROPOSAL_STATUS_LABEL[proposal.status]}
                tone={
                  proposal.status === 'merged'
                    ? 'success'
                    : proposal.status === 'open'
                      ? 'warning'
                      : 'neutral'
                }
              />
              <Caption>#{proposal.number}</Caption>
            </Row>
            <Title>{proposal.title}</Title>
            <Caption>
              {proposal.guestName
                ? `${proposal.guestName} (받기 함으로 보냄 · ${proposal.author.displayName} 님의 링크)`
                : proposal.author.displayName}{' '}
              · {formatRelativeTime(proposal.createdAt)} ·{' '}
              {repo.name}
            </Caption>
          </View>

          {proposal.description ? (
            <Card>
              <Body>{proposal.description}</Body>
            </Card>
          ) : null}

          {proposal.status === 'open' && proposal.conflicts.length > 0 ? (
            <Card style={{ backgroundColor: colors.warningSoft, gap: spacing.sm }}>
              <Row gap={spacing.sm}>
                <Ionicons name="warning-outline" size={18} color={colors.warning} />
                <Body style={{ color: colors.warning, fontWeight: '600', flex: 1 }}>
                  지금은 반영할 수 없습니다
                </Body>
              </Row>
              {conflictGroups(proposal, canResolve).map((group) => (
                <View key={group.title} style={{ gap: spacing.xs }}>
                  <Caption style={{ color: colors.warning }}>{group.title}</Caption>
                  {group.paths.map((path) => {
                    const detail = conflictDetails.find((c) => c.path === path);
                    if (!canResolve || !detail) {
                      return (
                        <Body key={path} style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>
                          {path}
                        </Body>
                      );
                    }
                    const value = chosen(path, detail.reason, detail.autoMerge);
                    const options: { key: ConflictResolution; label: string }[] =
                      detail.reason === 'name'
                        ? [{ key: 'theirs', label: '제안에서 빼기' }]
                        : [
                            ...(detail.autoMerge ? [{ key: 'merge' as const, label: '자동으로 합치기' }] : []),
                            { key: 'mine', label: '제안 것으로' },
                            { key: 'theirs', label: '저장소 것으로' },
                          ];
                    return (
                      <View key={path} style={{ gap: spacing.xs, paddingVertical: spacing.xs }}>
                        <Body style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>{path}</Body>
                        <Row gap={spacing.xs} wrap>
                          {options.map((option) => {
                            const active = value === option.key;
                            return (
                              <Pressable
                                key={option.key}
                                onPress={() => setChoices((prev) => ({ ...prev, [path]: option.key }))}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`${path}: ${option.label}`}
                                style={{
                                  paddingHorizontal: spacing.md,
                                  paddingVertical: spacing.xs + 2,
                                  borderRadius: radius.pill,
                                  borderWidth: 1,
                                  borderColor: active ? colors.accent : colors.border,
                                  backgroundColor: active ? colors.accentSoft : colors.surface,
                                }}
                              >
                                <Caption style={{ color: active ? colors.accent : colors.textMuted, fontWeight: active ? '600' : '400' }}>
                                  {option.label}
                                </Caption>
                              </Pressable>
                            );
                          })}
                        </Row>
                      </View>
                    );
                  })}
                </View>
              ))}
              {canResolve ? (
                <Row gap={spacing.sm} wrap>
                  <Button
                    label="고른 대로 정리"
                    icon="checkmark-done-outline"
                    compact
                    onPress={() => void resolveConflicts(false)}
                    loading={action === 'resolve'}
                    disabled={!allChosen || action !== null}
                  />
                  {canMerge && proposal.changes.length > conflictDetails.length ? (
                    <Button
                      label="충돌 난 파일만 빼고 반영"
                      variant="secondary"
                      compact
                      onPress={() => void resolveConflicts(true)}
                      loading={action === 'resolve-merge'}
                      disabled={action !== null}
                    />
                  ) : null}
                </Row>
              ) : null}
            </Card>
          ) : null}

          {actionError ? <ErrorNotice message={actionError} /> : null}

          <Card padded={false} style={{ paddingVertical: spacing.sm }}>
            <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
              <Body style={{ fontWeight: '600' }}>바뀌는 파일 ({proposal.changes.length})</Body>
            </View>
            {shownChanges(proposal.changes).map(({ change, movedFrom }, index) => (
              <View key={change.path}>
                {index > 0 ? <Divider /> : null}
                <ChangeRow
                  change={change}
                  movedFrom={movedFrom}
                  proposalId={proposal.id}
                  repoId={proposal.repoId}
                  status={proposal.status}
                  baseSnapshotId={proposal.baseSnapshotId}
                />
              </View>
            ))}
          </Card>

          {proposal.status === 'open' ? (
            canManage ? (
              <Row gap={spacing.sm} wrap>
                {canMerge ? (
                  <Button
                    label="저장소에 반영"
                    icon="git-merge-outline"
                    onPress={merge}
                    loading={action === 'merge'}
                    disabled={!proposal.mergeable}
                  />
                ) : null}
                <Button
                  label="제안 닫기"
                  variant="secondary"
                  onPress={close}
                  loading={action === 'close'}
                />
              </Row>
            ) : null
          ) : proposal.status === 'closed' ? (
            canManage ? (
              <Button
                label="다시 열기"
                variant="secondary"
                onPress={() => void run('reopen', () => api.reopenProposal(proposal.id))}
                loading={action === 'reopen'}
              />
            ) : (
              <Caption>
                닫힌 제안입니다. 다시 열기는 작성자 본인이나 편집 권한이 있는 멤버만 할 수 있습니다.
              </Caption>
            )
          ) : (
            <Row gap={spacing.sm}>
              <Ionicons name="checkmark-circle" size={18} color={colors.success} />
              <Caption style={{ color: colors.success }}>
                저장소에 반영되었습니다. 파일 목록에서 확인할 수 있습니다.
              </Caption>
            </Row>
          )}

          {!canMerge && proposal.status === 'open' ? (
            <Caption>
              {canManage
                ? '반영은 편집 권한이 있는 멤버가 할 수 있습니다.'
                : '반영은 편집 권한이 있는 멤버가, 닫기는 작성자 본인이나 편집 권한이 있는 멤버만 할 수 있습니다.'}
            </Caption>
          ) : null}

          <Card style={{ gap: spacing.md }}>
            <Body style={{ fontWeight: '600' }}>의견 ({proposal.comments.length})</Body>

            {proposal.comments.length === 0 ? (
              <Caption>아직 의견이 없습니다.</Caption>
            ) : (
              <View style={{ gap: spacing.md }}>
                {proposal.comments.map((item) => (
                  <View
                    key={item.id}
                    style={{
                      backgroundColor: colors.surfaceAlt,
                      borderRadius: radius.md,
                      padding: spacing.md,
                      gap: spacing.xs,
                    }}
                  >
                    <Row gap={spacing.sm}>
                      <Body style={{ fontWeight: '600', fontSize: fontSize.sm }}>
                        {item.author.displayName}
                      </Body>
                      <Caption>{formatRelativeTime(item.createdAt)}</Caption>
                    </Row>
                    <Body>{item.body}</Body>
                  </View>
                ))}
              </View>
            )}

            <Field label="의견 남기기">
              <Input
                value={comment}
                onChangeText={setComment}
                placeholder="검토 의견을 적어 주세요."
                multiline
                style={{ minHeight: 72, textAlignVertical: 'top' }}
              />
            </Field>
            <Button
              label="의견 등록"
              onPress={submitComment}
              loading={action === 'comment'}
              disabled={!comment.trim()}
            />
          </Card>

          <Button
            label="저장소로 돌아가기"
            variant="ghost"
            onPress={() => router.replace(`/repo/${proposal.repoId}`)}
          />
        </>
      ) : null}
    </Screen>
  );
}

/**
 * 이동은 "원래 자리 지우기 + 새 자리 더하기" 두 줄로 온다(API 수준 5). 더하는 줄 하나로 보이고, 원래 자리의 삭제 줄은
 * 그 안에 함께 적는다. 짝이 없는 삭제·더하기는 그대로.
 */
function shownChanges(changes: ProposalChange[]): { change: ProposalChange; movedFrom?: ProposalChange }[] {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const sources = new Set(changes.map((change) => change.movedFrom).filter((path): path is string => !!path && byPath.get(path)?.op === 'delete'));
  return changes
    .filter((change) => !(change.op === 'delete' && sources.has(change.path)))
    .map((change) => ({ change, movedFrom: change.movedFrom ? byPath.get(change.movedFrom) : undefined }));
}

function ChangeRow({
  change,
  movedFrom,
  proposalId,
  repoId,
  status,
  baseSnapshotId,
}: {
  change: ProposalChange;
  /** 이동이면 원래 자리의 삭제 줄. */
  movedFrom?: ProposalChange;
  proposalId: string;
  repoId: string;
  status: ProposalStatus;
  baseSnapshotId: string | null;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState<'proposed' | 'base' | null>(null);

  const moved = !!movedFrom;
  const tone = moved ? 'accent' : change.op === 'add' ? 'success' : change.op === 'delete' ? 'danger' : 'accent';
  const name = baseName(change.path);
  // 병합·닫힘 뒤에는 현재본이 이미 바뀌었을 수 있으므로 제안 당시 스냅샷의 원본을 내려준다.
  const baseIsCurrent = status === 'open';

  async function grab(kind: 'proposed' | 'base') {
    setBusy(kind);
    try {
      const url =
        kind === 'proposed'
          ? api.proposalFileUrl(proposalId, change.path)
          : api.fileUrl(repoId, change.path, {
              snapshotId: baseIsCurrent ? undefined : (baseSnapshotId ?? undefined),
            });
      const baseFileName = baseIsCurrent ? `현재-${name}` : `원본-${name}`;
      const result = await downloadFile(url, kind === 'base' ? baseFileName : `제안-${name}`);
      if (result.message) (result.ok ? notifySuccess : notifyError)(result.message);
    } catch {
      notifyError('내려받지 못했습니다.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm }}>
      <Row gap={spacing.sm}>
        <Badge label={moved ? '이동' : CHANGE_OP_LABEL[change.op]} tone={tone} />
        <Body numberOfLines={3} style={{ flex: 1, fontFamily: monoFont, fontSize: fontSize.sm }}>
          {moved ? `${movedFrom.path} → ${change.path}` : change.path}
        </Body>
      </Row>

      <Row gap={spacing.md} wrap>
        {moved ? (
          <Caption>
            {movedFrom.baseBlobHash === change.blobHash
              ? `내용 그대로 옮김 · ${formatBytes(change.size)}`
              : `옮기면서 내용도 바뀜 · ${formatBytes(movedFrom.baseSize ?? 0)} → ${formatBytes(change.size)}`}
          </Caption>
        ) : change.op === 'delete' ? (
          <Caption>현재 {formatBytes(change.baseSize ?? 0)} → 삭제</Caption>
        ) : change.op === 'update' ? (
          <Caption>
            {formatBytes(change.baseSize ?? 0)} → {formatBytes(change.size)}
          </Caption>
        ) : (
          <Caption>새 파일 {formatBytes(change.size)}</Caption>
        )}
      </Row>

      <Row gap={spacing.sm} wrap>
        {change.blobHash ? (
          <Button
            label="제안본 받기"
            icon="download-outline"
            variant="secondary"
            compact
            loading={busy === 'proposed'}
            onPress={() => void grab('proposed')}
          />
        ) : null}
        {change.baseBlobHash ? (
          <Button
            label={baseIsCurrent ? '현재본 받기' : '제안 당시 원본 받기'}
            icon="download-outline"
            variant="ghost"
            compact
            loading={busy === 'base'}
            onPress={() => void grab('base')}
          />
        ) : null}
        {busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      </Row>
    </View>
  );
}

/**
 * 병합을 막는 경로를 이유별로 묶어 설명을 붙인다. 이유를 알려주지 않는 서버(1.3.0 까지)는 한 묶음으로.
 */
function conflictGroups(proposal: ProposalDetail, resolvable = false): { title: string; paths: string[] }[] {
  const details = proposal.conflictDetails;
  if (!details) {
    return [
      {
        title:
          '이 제안을 만든 뒤 아래 파일이 저장소에서 바뀌었거나, 이름이 겹치는 파일·폴더가 생겼습니다. 저장소의 최신 상태를 확인한 뒤 다시 제안해 주세요.',
        paths: proposal.conflicts,
      },
    ];
  }
  const changed = details.filter((d) => d.reason === 'changed').map((d) => d.path);
  const named = details.filter((d) => d.reason === 'name').map((d) => d.path);
  const groups: { title: string; paths: string[] }[] = [];
  if (changed.length > 0) {
    groups.push({
      title: resolvable
        ? '이 제안을 만든 뒤 저장소에서 바뀐 파일입니다. 파일마다 고르세요 — 텍스트는 자동으로 합칠 수 있고, 아니면 제안 것이나 저장소 것을 남깁니다.'
        : '이 제안을 만든 뒤 저장소에서 바뀐 파일입니다. 그대로 반영하면 그 변경을 덮어쓰므로, 최신 파일을 받아 다시 고쳐 제안해 주세요.',
      paths: changed,
    });
  }
  if (named.length > 0) {
    groups.push({
      title: resolvable
        ? '저장소에 같은 이름의 파일이나 폴더가 생겨 이 경로에 더할 수 없습니다. 제안에서 빼고 나머지를 반영하거나, 다른 이름으로 다시 제안해 주세요.'
        : '저장소에 같은 이름의 파일이나 폴더가 생겨 이 경로에 더할 수 없습니다(파일 아래에 파일을 두거나 폴더와 이름이 같아짐). 다른 이름이나 위치로 다시 제안해 주세요.',
      paths: named,
    });
  }
  return groups;
}
