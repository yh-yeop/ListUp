import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { formatBytes, formatDate, hasRole, type RepoStorage, type RepoSummary } from '@listup/shared';
import { Body, Button, Caption, Card, Divider, EmptyState, ErrorNotice, Loading, Row, Screen, Subtitle, Title } from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notifyError, notifySuccess } from '../../../src/lib/dialogs';
import { describeRetention } from '../../../src/lib/retention';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

/**
 * 저장소 용량 — 지금 파일, 변경 이력이 붙잡고 있는 크기, 내용이 같은 파일(중복), 큰 파일.
 * 편집자는 중복 묶음마다 하나만 남기고 정리할 수 있다(지운 것도 이력에 남아 되돌릴 수 있다).
 */
export default function StorageScreen() {
  const { repoId } = useLocalSearchParams<{ repoId: string }>();
  const { colors } = useTheme();
  const [cleaning, setCleaning] = useState<string | null>(null);

  const state = useAsync<{ repo: RepoSummary; storage: RepoStorage }>(async () => {
    const [{ repo }, storage] = await Promise.all([api.getRepo(repoId), api.repoStorage(repoId)]);
    return { repo, storage };
  }, [repoId]);

  const repo = state.data?.repo;
  const storage = state.data?.storage;
  const canClean = hasRole(repo?.role, 'editor') && !repo?.mirror;

  /** 묶음에서 keep 만 남기고 나머지를 지운다. */
  async function keepOnly(group: RepoStorage['duplicates'][number], keep: string) {
    const remove = group.paths.filter((path) => path !== keep);
    const ok = await confirmAction({
      title: `${keep} 만 남길까요?`,
      message: `내용이 같은 ${remove.length}개를 지웁니다:\n${remove.join('\n')}\n\n지운 파일도 변경 이력에서 되돌릴 수 있습니다.`,
      confirmLabel: '정리하기',
      destructive: true,
    });
    if (!ok) return;
    setCleaning(group.hash);
    try {
      await api.commitFiles(
        repoId,
        remove.map((path) => ({ path, blobHash: null })),
        `중복 정리: ${keep} 만 남김`,
      );
      notifySuccess('중복을 정리했습니다.', `${formatBytes(group.size * remove.length)} 를 아꼈습니다.`);
      state.refresh();
    } catch (err) {
      notifyError('정리하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      setCleaning(null);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />}>
      <Stack.Screen options={{ title: '용량' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>용량</Title>
        <Subtitle>저장소가 디스크를 얼마나, 어디에 쓰는지 봅니다.</Subtitle>
      </View>
      <RepoNav repoId={repoId} openProposals={repo?.openProposalCount} />

      {state.loading && !storage ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : storage ? (
        <>
          <Row gap={spacing.md} wrap>
            <Stat label="지금 파일" value={formatBytes(storage.current.bytes)} detail={`${storage.current.files}개`} />
            <Stat
              label="이력이 붙잡은 크기"
              value={formatBytes(storage.history.extraBytes)}
              detail={`시점 ${storage.history.snapshots}개${storage.history.oldestAt ? ` · ${formatDate(storage.history.oldestAt)} 부터` : ''}`}
            />
            <Stat label="중복" value={formatBytes(storage.duplicateBytes)} detail={`${storage.duplicates.length}묶음`} />
          </Row>

          <Card style={{ gap: spacing.xs }}>
            <Row gap={spacing.sm}>
              <Ionicons name="time-outline" size={16} color={colors.textMuted} />
              <Body style={{ fontWeight: '600' }}>이력 보존</Body>
            </Row>
            <Caption>{describeRetention(storage.retention)}</Caption>
            <Caption>
              지금 파일에는 없고 지난 시점에만 있는 내용이 "이력이 붙잡은 크기"입니다. 보존 기간이 지나 정리되면 디스크로
              돌아옵니다. 보존 기간은 서버를 돌리는 사람이 정합니다.
            </Caption>
          </Card>

          <Card padded={false} style={{ paddingVertical: spacing.sm }}>
            <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 2 }}>
              <Body style={{ fontWeight: '600' }}>내용이 같은 파일</Body>
              <Caption>이름이나 위치는 달라도 내용이 똑같은 파일들입니다. 아낄 수 있는 크기가 큰 것부터.</Caption>
            </View>
            {storage.duplicates.length === 0 ? (
              <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
                <Caption>중복이 없습니다.</Caption>
              </View>
            ) : (
              storage.duplicates.map((group) => (
                <View key={group.hash}>
                  <Divider />
                  <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs }}>
                    <Caption>
                      {group.paths.length}개 × {formatBytes(group.size)} — {formatBytes(group.size * (group.paths.length - 1))} 아낄 수 있음
                    </Caption>
                    {group.paths.map((path) => (
                      <Row key={path} gap={spacing.sm} style={{ justifyContent: 'space-between' }}>
                        <Body numberOfLines={1} style={{ flex: 1, fontFamily: monoFont, fontSize: fontSize.sm }}>
                          {path}
                        </Body>
                        {canClean ? (
                          <Button
                            label="이것만 남기기"
                            variant="ghost"
                            compact
                            loading={cleaning === group.hash}
                            disabled={cleaning !== null}
                            onPress={() => void keepOnly(group, path)}
                          />
                        ) : null}
                      </Row>
                    ))}
                  </View>
                </View>
              ))
            )}
          </Card>

          <Card padded={false} style={{ paddingVertical: spacing.sm }}>
            <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
              <Body style={{ fontWeight: '600' }}>큰 파일</Body>
            </View>
            {storage.largest.length === 0 ? (
              <EmptyState icon="document-outline" title="파일이 없습니다" description="파일을 올리면 여기에 큰 것부터 보입니다." />
            ) : (
              storage.largest.map((file) => (
                <View key={file.path}>
                  <Divider />
                  <Row gap={spacing.md} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
                    <Body numberOfLines={1} style={{ flex: 1, fontFamily: monoFont, fontSize: fontSize.sm }}>
                      {file.path}
                    </Body>
                    <Caption>{formatBytes(file.size)}</Caption>
                  </Row>
                </View>
              ))
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 160,
        padding: spacing.lg,
        gap: 2,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Caption>{label}</Caption>
      <Body style={{ fontSize: fontSize.xl, fontWeight: '700' }}>{value}</Body>
      <Caption>{detail}</Caption>
    </View>
  );
}
