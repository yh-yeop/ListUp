import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, Share as ShareSheet, View } from 'react-native';
import {
  baseName,
  formatBytes,
  formatDate,
  formatRelativeTime,
  hasRole,
  type RepoSummary,
  type Share,
  type ShareKind,
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
  Field,
  Input,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { RepoNav } from '../../../src/components/RepoNav';
import { ApiError, api } from '../../../src/api/client';
import { confirmAction, notifyError, notifySuccess } from '../../../src/lib/dialogs';
import { isLocalNetworkAddress } from '../../../src/lib/invite-link';
import { shareLinkFor, useLinkBase } from '../../../src/lib/share-link';
import { useAsync } from '../../../src/lib/useAsync';
import { LEVEL_1_4, useServerLevel } from '../../../src/lib/useServerLevel';
import { fontSize, monoFont, radius, spacing, useTheme } from '../../../src/theme';

const EXPIRY_OPTIONS = [
  { label: '1일', days: 1 },
  { label: '7일', days: 7 },
  { label: '30일', days: 30 },
  { label: '기한 없음', days: null },
];
const USE_OPTIONS = [
  { label: '무제한', uses: null },
  { label: '1회', uses: 1 },
  { label: '5회', uses: 5 },
  { label: '20회', uses: 20 },
];
const SIZE_OPTIONS = [
  { label: '100MB', mb: 100 },
  { label: '1GB', mb: 1024 },
  { label: '4GB', mb: 4096 },
];

const KIND_LABEL: Record<ShareKind, string> = { download: '받기 링크', upload: '받기 함', mirror: '따라가기 키' };

/**
 * 공유 링크 — 계정 없는 사람에게 파일을 건네는 받기 링크, 파일을 받아 오는 받기 함, 다른 서버가 이 저장소를
 * 따라가게 하는 따라가기 키. `?path=` 로 오면 그 파일·폴더의 받기 링크를, `?inbox=` 로 오면 그 폴더의 받기 함을
 * 만들 준비를 해 둔다.
 */
export default function SharesScreen() {
  const { repoId, path: targetParam, inbox: inboxParam } = useLocalSearchParams<{ repoId: string; path?: string; inbox?: string }>();
  const { colors } = useTheme();
  const linkBase = useLinkBase();
  const serverLevel = useServerLevel();
  const [kind, setKind] = useState<ShareKind>(inboxParam !== undefined ? 'upload' : 'download');
  const [target, setTarget] = useState(targetParam ?? inboxParam ?? '');
  const [label, setLabel] = useState('');
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [maxMb, setMaxMb] = useState(1024);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync<{ repo: RepoSummary; shares: Share[] }>(async () => {
    const { repo } = await api.getRepo(repoId);
    if (!hasRole(repo.role, 'editor')) return { repo, shares: [] };
    const { shares } = await api.listShares(repoId);
    return { repo, shares };
  }, [repoId]);

  const repo = state.data?.repo;
  const canShare = hasRole(repo?.role, 'editor');
  const isOwner = repo?.role === 'owner';
  const localOnly = isLocalNetworkAddress(shareLinkFor(linkBase, 'x'));

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const { share } = await api.createShare(repoId, {
        kind,
        ...(kind !== 'mirror' ? { path: target.trim().replace(/^\/+|\/+$/g, ''), label: label.trim() || undefined } : {}),
        ...(kind !== 'mirror' ? { expiresInDays: expiryDays } : {}),
        ...(kind === 'download' ? { maxUses } : {}),
        ...(kind === 'upload' ? { maxMb } : {}),
      });
      await Clipboard.setStringAsync(shareLinkFor(linkBase, share.token));
      notifySuccess(`${KIND_LABEL[kind]}를 만들고 링크를 복사했습니다.`, localOnly ? '이 링크는 같은 공유기(네트워크) 안에서만 열립니다.' : undefined);
      setLabel('');
      state.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '링크를 만들지 못했습니다.');
    } finally {
      setCreating(false);
    }
  }

  async function copy(share: Share) {
    await Clipboard.setStringAsync(shareLinkFor(linkBase, share.token));
    notifySuccess('링크를 복사했습니다.', share.kind === 'mirror' ? '다른 ListUp 서버의 "다른 서버 저장소 따라가기"에 넣으면 됩니다.' : undefined);
  }

  async function revoke(share: Share) {
    const ok = await confirmAction({
      title: `이 ${KIND_LABEL[share.kind]}를 회수할까요?`,
      message: share.kind === 'mirror' ? '따라오던 서버는 더 이상 새 내용을 가져오지 못합니다(이미 가진 사본은 그 서버에 남습니다).' : '앞으로 이 링크는 열리지 않습니다.',
      confirmLabel: '회수',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.revokeShare(share.id);
      state.refresh();
    } catch (err) {
      notifyError('회수하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} tintColor={colors.textMuted} />}>
      <Stack.Screen options={{ title: '공유 링크' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>공유 링크</Title>
        <Subtitle>
          계정이 없는 사람에게 파일을 건네거나(받기 링크) 받아 올 때(받기 함) 씁니다. 받기 함으로 들어온 파일은 바로
          들어가지 않고 변경 제안이 되어, 확인한 뒤 반영합니다.
        </Subtitle>
      </View>
      <RepoNav repoId={repoId} openProposals={repo?.openProposalCount} />

      {state.loading && !repo ? (
        <Loading />
      ) : state.error ? (
        <ErrorNotice message={state.error} onRetry={state.reload} />
      ) : serverLevel > 0 && serverLevel < LEVEL_1_4 ? (
        <Card>
          <EmptyState icon="link-outline" title="이 서버는 공유 링크를 모릅니다" description="서버를 1.4.0 이상으로 올리면 쓸 수 있습니다." />
        </Card>
      ) : !canShare ? (
        <Card>
          <EmptyState icon="lock-closed-outline" title="편집 권한이 필요합니다" description="공유 링크는 편집 권한이 있는 멤버가 만들고 관리합니다." />
        </Card>
      ) : (
        <>
          <Card style={{ gap: spacing.lg }}>
            <Row gap={spacing.xs} wrap>
              {(['download', 'upload', ...(isOwner ? (['mirror'] as const) : [])] as ShareKind[]).map((value) => (
                <Chip key={value} label={KIND_LABEL[value]} active={kind === value} onPress={() => setKind(value)} />
              ))}
            </Row>
            <Caption>
              {kind === 'download'
                ? '링크를 아는 사람은 로그인 없이 그 파일(폴더면 안의 파일과 zip)을 받습니다.'
                : kind === 'upload'
                  ? '링크를 아는 사람은 로그인 없이 파일을 보냅니다. 보낸 파일은 그 폴더로 가는 변경 제안이 되고, 같은 이름이 있어도 덮어쓰지 않습니다.'
                  : '다른 ListUp 서버가 이 저장소를 읽기 전용 사본으로 따라갑니다(바뀐 것만 가져옴). 저장소 전체를 가져갈 수 있는 열쇠이니 믿는 사람에게만 주세요.'}
            </Caption>

            {kind !== 'mirror' ? (
              <>
                <Field
                  label={kind === 'download' ? '보낼 파일·폴더' : '받은 파일이 들어갈 폴더'}
                  hint={target.trim() ? undefined : kind === 'download' ? '비우면 저장소 전체입니다.' : '비우면 저장소 맨 위입니다.'}
                >
                  <Input value={target} onChangeText={setTarget} autoCapitalize="none" placeholder="예: 사진/2026 여행" />
                </Field>
                <Field label="이름" hint="받는 사람에게 보입니다. 비워도 됩니다.">
                  <Input
                    value={label}
                    onChangeText={setLabel}
                    maxLength={60}
                    placeholder={kind === 'download' ? `예: ${target ? baseName(target) : '자료'} 나눔` : '예: 모임 사진 받기'}
                  />
                </Field>
                <Field label="기간">
                  <Row gap={spacing.xs} wrap>
                    {EXPIRY_OPTIONS.map((option) => (
                      <Chip key={option.label} label={option.label} active={expiryDays === option.days} onPress={() => setExpiryDays(option.days)} />
                    ))}
                  </Row>
                </Field>
                {kind === 'download' ? (
                  <Field label="받을 수 있는 횟수" hint="이어받기는 세지 않습니다.">
                    <Row gap={spacing.xs} wrap>
                      {USE_OPTIONS.map((option) => (
                        <Chip key={option.label} label={option.label} active={maxUses === option.uses} onPress={() => setMaxUses(option.uses)} />
                      ))}
                    </Row>
                  </Field>
                ) : (
                  <Field label="받을 수 있는 총량">
                    <Row gap={spacing.xs} wrap>
                      {SIZE_OPTIONS.map((option) => (
                        <Chip key={option.label} label={option.label} active={maxMb === option.mb} onPress={() => setMaxMb(option.mb)} />
                      ))}
                    </Row>
                  </Field>
                )}
              </>
            ) : null}

            {error ? <ErrorNotice message={error} /> : null}
            <Button label={`${KIND_LABEL[kind]} 만들기`} icon="link-outline" onPress={() => void create()} loading={creating} />
          </Card>

          {state.data && state.data.shares.length > 0 ? (
            <Card padded={false} style={{ paddingVertical: spacing.sm }}>
              {state.data.shares.map((share, index) => (
                <View key={share.id}>
                  {index > 0 ? <Divider /> : null}
                  <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs }}>
                    <Row gap={spacing.sm} wrap>
                      <Badge label={KIND_LABEL[share.kind]} tone={share.kind === 'upload' ? 'accent' : 'neutral'} />
                      {!share.active ? <Badge label={share.revokedAt ? '회수됨' : '쓸 수 없음'} tone="neutral" /> : null}
                      <Body style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>
                        {share.label || (share.kind === 'mirror' ? '저장소 전체' : share.path || '저장소 전체')}
                      </Body>
                    </Row>
                    <Caption style={{ fontFamily: monoFont }} numberOfLines={1}>
                      {shareLinkFor(linkBase, share.token)}
                    </Caption>
                    <Caption>
                      {[
                        share.kind !== 'mirror' ? share.path || '저장소 전체' : null,
                        share.expiresAt ? `${formatDate(share.expiresAt)} 까지` : '기한 없음',
                        share.kind === 'download' ? `${share.useCount}${share.maxUses ? `/${share.maxUses}` : ''}회 받음` : null,
                        share.kind === 'upload'
                          ? `${share.useCount}번 받음 · ${formatBytes(share.usedBytes)}${share.maxBytes ? ` / ${formatBytes(share.maxBytes)}` : ''}`
                          : null,
                        `${share.createdBy.displayName} · ${formatRelativeTime(share.createdAt)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Caption>
                    {share.active ? (
                      <Row gap={spacing.sm} wrap>
                        <Button label="링크 복사" icon="copy-outline" variant="secondary" compact onPress={() => void copy(share)} />
                        {share.kind !== 'mirror' ? (
                          <Button
                            label="보내기"
                            icon="share-outline"
                            variant="secondary"
                            compact
                            onPress={() =>
                              void ShareSheet.share({ message: `${share.label || 'ListUp'}: ${shareLinkFor(linkBase, share.token)}` })
                            }
                          />
                        ) : null}
                        <Button label="회수" variant="ghost" compact onPress={() => void revoke(share)} />
                      </Row>
                    ) : null}
                  </View>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm - 2,
        borderRadius: radius.pill,
        backgroundColor: active ? colors.accentSoft : colors.surfaceAlt,
      }}
    >
      <Body style={{ color: active ? colors.accent : colors.textMuted, fontSize: fontSize.sm }}>{label}</Body>
    </Pressable>
  );
}
