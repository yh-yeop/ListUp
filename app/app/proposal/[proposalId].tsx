import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, View } from 'react-native';
import {
  CHANGE_OP_LABEL,
  PROPOSAL_STATUS_LABEL,
  baseName,
  formatBytes,
  formatRelativeTime,
  hasRole,
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
import { confirmAction, notify } from '../../src/lib/dialogs';
import { downloadFile } from '../../src/lib/files';
import { useAsync } from '../../src/lib/useAsync';
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
              {proposal.author.displayName} · {formatRelativeTime(proposal.createdAt)} ·{' '}
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
              <Caption style={{ color: colors.warning }}>
                이 제안을 만든 뒤 아래 파일이 저장소에서 바뀌었거나, 이름이 겹치는 파일·폴더가
                생겼습니다. 저장소의 최신 상태를 확인한 뒤 다시 제안해 주세요.
              </Caption>
              {proposal.conflicts.map((path) => (
                <Body key={path} style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>
                  {path}
                </Body>
              ))}
            </Card>
          ) : null}

          {actionError ? <ErrorNotice message={actionError} /> : null}

          <Card padded={false} style={{ paddingVertical: spacing.sm }}>
            <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
              <Body style={{ fontWeight: '600' }}>바뀌는 파일 ({proposal.changes.length})</Body>
            </View>
            {proposal.changes.map((change, index) => (
              <View key={change.path}>
                {index > 0 ? <Divider /> : null}
                <ChangeRow
                  change={change}
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

function ChangeRow({
  change,
  proposalId,
  repoId,
  status,
  baseSnapshotId,
}: {
  change: ProposalChange;
  proposalId: string;
  repoId: string;
  status: ProposalStatus;
  baseSnapshotId: string | null;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState<'proposed' | 'base' | null>(null);

  const tone = change.op === 'add' ? 'success' : change.op === 'delete' ? 'danger' : 'accent';
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
      if (result.message) notify(result.message);
    } catch {
      notify('내려받지 못했습니다.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm }}>
      <Row gap={spacing.sm}>
        <Badge label={CHANGE_OP_LABEL[change.op]} tone={tone} />
        <Body numberOfLines={2} style={{ flex: 1, fontFamily: monoFont, fontSize: fontSize.sm }}>
          {change.path}
        </Body>
      </Row>

      <Row gap={spacing.md} wrap>
        {change.op === 'delete' ? (
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
