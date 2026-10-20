import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import {
  baseName,
  formatBytes,
  formatDateTime,
  formatRelativeTime,
  hasRole,
  type FileVersion,
  type RepoSummary,
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
import { monoFont, spacing, useTheme } from '../../../src/theme';

type Cursor = { before: number; beforeId: string };

const OP: Record<FileVersion['op'], { label: string; tone: 'success' | 'accent' | 'danger' }> = {
  added: { label: '추가', tone: 'success' },
  updated: { label: '수정', tone: 'accent' },
  deleted: { label: '삭제', tone: 'danger' },
};

interface VersionsView {
  repo: RepoSummary;
  versions: FileVersion[];
  next: Cursor | null;
  /** 이 기능이 없는 옛 서버 */
  missing: boolean;
}

/**
 * 파일 하나의 버전 — 그 경로를 바꾼 시점들, 최근 것부터. 맨 위가 삭제가 아니면 그것이 지금 내용이다.
 * 예전 버전을 받거나, 그 내용으로 되돌린다(편집자는 바로, 열람자는 변경 제안으로).
 */
export default function VersionsScreen() {
  const { repoId, path } = useLocalSearchParams<{ repoId: string; path: string }>();
  const { colors } = useTheme();
  const [more, setMore] = useState<{ from: FileVersion[]; versions: FileVersion[]; next: Cursor | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const state = useAsync<VersionsView>(async () => {
    const { repo } = await api.getRepo(repoId);
    try {
      const page = await api.fileVersions(repoId, path);
      return { repo, ...page, missing: false };
    } catch (err) {
      if (isMissingFeature(err)) return { repo, versions: [], next: null, missing: true };
      throw err;
    }
  }, [repoId, path]);

  const firstPage = state.data?.versions;
  const extra = more && more.from === firstPage ? more : null;
  const versions = [...(firstPage ?? []), ...(extra?.versions ?? [])];
  const next = extra ? extra.next : (state.data?.next ?? null);
  const isEditor = hasRole(state.data?.repo.role, 'editor');
  // 맨 위 변경이 지금 상태다. 삭제면 지금은 파일이 없다.
  const current = versions[0] && versions[0].op !== 'deleted' ? versions[0] : null;
  const name = baseName(path);

  async function loadMore() {
    if (!firstPage || !next || busy) return;
    setBusy('more');
    try {
      const page = await api.fileVersions(repoId, path, next);
      setMore((prev) => ({
        from: firstPage,
        versions: [...(prev && prev.from === firstPage ? prev.versions : []), ...page.versions],
        next: page.next,
      }));
    } catch (err) {
      notifyError(err instanceof ApiError ? err.message : '더 불러오지 못했습니다.');
    } finally {
      setBusy(null);
    }
  }

  async function download(version: FileVersion) {
    setBusy(version.snapshotId);
    try {
      const result = await downloadFromRepo(repoId, { path, snapshotId: version.snapshotId, fileName: name });
      if (result.message) notify(result.message);
    } catch (err) {
      notifyError('내려받지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: FileVersion) {
    if (!version.blobHash) return;
    const when = formatDateTime(version.createdAt);
    const ok = await confirmAction({
      title: isEditor ? '이 버전으로 되돌릴까요?' : '이 버전으로 되돌리자고 제안할까요?',
      message: isEditor
        ? `${path}\n${when} 버전(${formatBytes(version.size ?? 0)})으로 바꿉니다. 지금 내용도 변경 이력에 남아 다시 되돌릴 수 있습니다.`
        : `${path}\n${when} 버전으로 되돌리는 변경 제안을 만듭니다. 편집자가 확인한 뒤 반영합니다.`,
      confirmLabel: isEditor ? '되돌리기' : '제안 만들기',
    });
    if (!ok) return;
    setBusy(version.snapshotId);
    try {
      const result = await restoreFiles(repoId, [{ path, blobHash: version.blobHash }], {
        isEditor,
        message: `되돌림: ${path} (${when} 버전)`.slice(0, 200),
      });
      if (result.kind === 'proposal') {
        router.push(`/proposal/${result.proposalId}`);
        return;
      }
      notifySuccess(`${when} 버전으로 되돌렸습니다.`);
      setMore(null);
      state.refresh();
    } catch (err) {
      notifyError('되돌리지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />
      }
    >
      <Stack.Screen options={{ title: '파일 버전' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>{name}</Title>
        <Caption style={{ fontFamily: monoFont }}>{path}</Caption>
        <Subtitle>
          이 파일이 바뀐 시점들입니다. 예전 버전을 받거나, 그 내용으로 되돌릴 수 있습니다. 되돌려도 지금 내용은
          이력에 남습니다.
        </Subtitle>
      </View>

      {state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : state.data?.missing ? (
        <ErrorNotice message={MISSING_FEATURE_MESSAGE} />
      ) : versions.length === 0 ? (
        <Card>
          <EmptyState icon="time-outline" title="기록이 없습니다" description="이 경로를 바꾼 기록이 없습니다." />
        </Card>
      ) : (
        <Card padded={false} style={{ paddingVertical: spacing.sm }}>
          {versions.map((version, index) => {
            const isCurrent = version === current;
            const sameAsCurrent = !isCurrent && current !== null && version.blobHash === current.blobHash;
            const canRestore = version.op !== 'deleted' && !isCurrent && !sameAsCurrent;
            return (
              <View key={version.snapshotId}>
                {index > 0 ? <Divider /> : null}
                <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm }}>
                  <Row gap={spacing.sm} wrap>
                    <Badge label={OP[version.op].label} tone={OP[version.op].tone} />
                    {isCurrent ? <Badge label="지금" tone="neutral" /> : null}
                    {sameAsCurrent ? <Caption>지금과 같은 내용</Caption> : null}
                  </Row>
                  <Body>{version.message || '변경'}</Body>
                  <Row gap={spacing.md} wrap>
                    <Caption>{version.author.displayName}</Caption>
                    <Caption>{formatRelativeTime(version.createdAt)}</Caption>
                    {version.size !== null ? <Caption>{formatBytes(version.size)}</Caption> : null}
                  </Row>
                  {version.op !== 'deleted' ? (
                    <Row gap={spacing.sm} wrap>
                      <Button
                        label="이 버전 받기"
                        icon="download-outline"
                        variant="secondary"
                        compact
                        loading={busy === version.snapshotId}
                        disabled={busy !== null}
                        onPress={() => void download(version)}
                      />
                      {canRestore ? (
                        <Button
                          label={isEditor ? '이 버전으로 되돌리기' : '되돌리기 제안'}
                          icon="arrow-undo-outline"
                          variant="secondary"
                          compact
                          disabled={busy !== null}
                          onPress={() => void restore(version)}
                        />
                      ) : null}
                    </Row>
                  ) : null}
                </View>
              </View>
            );
          })}
          {next ? (
            <>
              <Divider />
              <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs }}>
                <Button
                  label="더 보기"
                  icon="chevron-down"
                  variant="secondary"
                  compact
                  full
                  loading={busy === 'more'}
                  onPress={() => void loadMore()}
                />
              </View>
            </>
          ) : null}
        </Card>
      )}
    </Screen>
  );
}
