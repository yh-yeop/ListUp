import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, Switch, Text, View } from 'react-native';
import { formatBytes, hasRole, normalizePath, type RepoSummary } from '@listup/shared';
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
import { useAbortable } from '../../../src/lib/useAbortable';
import { ApiError, api, getMaxUploadBytes, resolveApiUrl } from '../../../src/api/client';
import { confirmAction, notify, notifyError, notifySuccess, notifyWarning } from '../../../src/lib/dialogs';
import {
  compareFolder,
  contentFindings,
  hashCandidates,
  listRepoFolder,
  type RepoFile,
} from '../../../src/lib/folder-compare';
import { HashAbortedError, hashWithMemo } from '../../../src/lib/hash';
import { localFolderSupported, pickLocalFolder, type LocalEntry, type LocalFolder } from '../../../src/lib/local-folder';
import { uploadAndCommit, uploadMany, type UploadProgress } from '../../../src/lib/transfer';
import { fontSize, monoFont, spacing, useTheme } from '../../../src/theme';

type Tab = 'repoOnly' | 'localOnly' | 'both' | 'moved';

/** 한 번에 그리는 최대 줄 수 — 수천 개를 한꺼번에 그리면 느리다. 고르기는 전체에 적용된다. */
const PAGE = 200;

/**
 * 내 폴더와 비교 — 저장소에서 보고 있던 폴더와 기기에서 고른 폴더를 파일 이름으로 견준다.
 * 폴더는 올 때마다 고르고 기억하지 않는다. 자동으로 다시 훑지 않는다.
 */
export default function CompareScreen() {
  const { repoId, path: rawPath } = useLocalSearchParams<{ repoId: string; path?: string }>();
  const basePath = rawPath ?? '';
  const { colors } = useTheme();

  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoFile[] | null>(null);
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const [byName, setByName] = useState(false);
  const [tab, setTab] = useState<Tab>('repoOnly');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ label: string; value: UploadProgress } | null>(null);
  const [hashing, setHashing] = useState(false);
  const busy = scanning || progress !== null || hashing;
  const uploadControl = useAbortable();
  /** 내용(해시)으로도 확인 — 같은 이름의 내용이 같은지, 옮기거나 이름만 바꾼 파일. */
  const [byContent, setByContent] = useState(false);
  const [localHashes, setLocalHashes] = useState<Map<string, string>>(new Map());
  const hashControl = useAbortable();

  const loadRepo = useCallback(async () => {
    const [{ repo: summary }, files] = await Promise.all([api.getRepo(repoId), listRepoFolder(repoId, basePath)]);
    setRepo(summary);
    setRepoFiles(files);
  }, [repoId, basePath]);

  useEffect(() => {
    loadRepo().catch((err) => setError(err instanceof ApiError ? err.message : '저장소 목록을 불러오지 못했습니다.'));
  }, [loadRepo]);

  const comparison = useMemo(
    () => (repoFiles && folder ? compareFolder(repoFiles, folder.entries, byName) : null),
    [repoFiles, folder, byName],
  );

  // 내용으로 확인하면 필요한 파일만 해시를 계산한다(크기가 맞는 것만). 같은 파일은 앱을 켜 있는 동안 다시 계산하지 않는다.
  useEffect(() => {
    if (!byContent || !comparison || !repoFiles || !folder) return;
    const candidates = hashCandidates(comparison, repoFiles).filter((entry) => !localHashes.has(entry.relativePath));
    if (candidates.length === 0) return;
    const signal = hashControl.start();
    const totalBytes = candidates.reduce((sum, entry) => sum + entry.size, 0);
    setHashing(true);
    void (async () => {
      const next = new Map(localHashes);
      let doneBytes = 0;
      try {
        for (const [index, entry] of candidates.entries()) {
          const report = (bytes: number) =>
            setProgress({
              label: '내용 확인 중',
              value: { sentBytes: doneBytes + bytes, totalBytes, doneFiles: index, totalFiles: candidates.length, current: entry.name },
            });
          report(0);
          const key = `${folder.label}|${entry.relativePath}|${entry.size}|${entry.mtime ?? ''}`;
          try {
            next.set(entry.relativePath, await hashWithMemo(key, entry.source, { signal, onProgress: report }));
          } catch (err) {
            if (err instanceof HashAbortedError) throw err;
            // 읽지 못한 파일은 모르는 채로 둔다.
          }
          doneBytes += entry.size;
        }
      } catch {
        // 멈췄다 — 계산한 데까지만 쓴다.
      } finally {
        hashControl.finish();
        setLocalHashes(next);
        setProgress(null);
        setHashing(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byContent, comparison, repoFiles, folder]);

  // 폴더를 새로 고르면 계산한 해시를 버린다(같은 경로라도 다른 파일이다).
  useEffect(() => {
    setLocalHashes(new Map());
  }, [folder?.label]);

  const findings = useMemo(
    () => (byContent && comparison && repoFiles ? contentFindings(comparison, localHashes, repoFiles) : null),
    [byContent, comparison, localHashes, repoFiles],
  );
  const movedLocal = new Set(findings?.moved.map((pair) => pair.local.relativePath));
  const movedRepo = new Set(findings?.moved.map((pair) => pair.repo.path));
  const alreadyIn = new Map(findings?.alreadyInRepo.map((pair) => [pair.local.relativePath, pair.repo.relativePath]));

  // 목록이 바뀌면 고른 것과 펼친 수를 처음으로.
  useEffect(() => {
    setSelected(new Set());
    setShown(PAGE);
  }, [comparison, tab]);

  const isEditor = hasRole(repo?.role, 'editor');
  const where = basePath ? `/${basePath}` : '저장소 맨 위';

  async function choose() {
    setError(null);
    setScanning(true);
    try {
      const picked = await pickLocalFolder();
      if (picked) {
        setFolder(picked);
        await loadRepo();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '폴더를 읽지 못했습니다.');
    } finally {
      setScanning(false);
    }
  }

  /** 받기·올리기 뒤 — 다시 훑을 수 있으면(PC 앱·안드로이드) 폴더도, 저장소는 늘 다시. */
  async function refresh() {
    setScanning(true);
    try {
      if (folder?.rescan) setFolder(await folder.rescan());
      await loadRepo();
    } catch (err) {
      setError(err instanceof Error ? err.message : '다시 견주지 못했습니다.');
    } finally {
      setScanning(false);
    }
  }

  const keyOfRepo = (file: RepoFile) => `repo:${file.path}`;
  const keyOfLocal = (entry: LocalEntry) => `local:${entry.relativePath}`;

  async function download(files: RepoFile[]) {
    if (!folder) return;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const toFolder = folder.save !== null;
    const ok = await confirmAction({
      title: `${files.length}개를 받을까요?`,
      message: toFolder
        ? `${formatBytes(totalBytes)} · '${folder.label}' 안에 저장소와 같은 폴더 구조로 넣습니다. 같은 이름이 이미 있으면 "이름 (1)" 로 둡니다.`
        : `${formatBytes(totalBytes)} · 브라우저는 고른 폴더에 쓸 수 없어 브라우저의 내려받기 폴더로 받습니다(폴더 구조 없이). 여러 파일을 받게 허용하라고 물을 수 있습니다. 폴더에 바로 넣으려면 PC 앱이나 안드로이드 앱을 쓰세요.`,
      confirmLabel: '받기',
    });
    if (!ok) return;

    const failures: string[] = [];
    let doneBytes = 0;
    for (const [index, file] of files.entries()) {
      const report = (fraction: number) =>
        setProgress({
          label: '받는 중',
          value: {
            sentBytes: doneBytes + file.size * fraction,
            totalBytes,
            doneFiles: index,
            totalFiles: files.length,
            current: file.name,
          },
        });
      report(0);
      try {
        const link = await api.downloadLink(repoId, { path: file.path });
        const url = resolveApiUrl(link.url);
        if (folder.save) {
          await folder.save(file.relativePath, url, report);
        } else {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.rel = 'noopener';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          // 브라우저가 연달아 누른 내려받기를 한데 묶어 막지 않게 조금씩 띄운다.
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      } catch (err) {
        failures.push(`${file.relativePath}: ${err instanceof Error ? err.message : '받지 못했습니다'}`);
      }
      doneBytes += file.size;
    }
    setProgress(null);
    (failures.length === 0 ? notifySuccess : notifyWarning)(
      failures.length === 0 ? `${files.length}개를 받았습니다.` : `${files.length - failures.length}개 받음, ${failures.length}개 실패`,
      failures.slice(0, 3).join('\n') || undefined,
    );
    if (toFolder) await refresh();
  }

  async function upload(entries: LocalEntry[]) {
    const maxBytes = await getMaxUploadBytes();
    const items = entries
      .filter((entry) => entry.size <= maxBytes)
      .map((entry) => ({ entry, path: normalizePath(basePath ? `${basePath}/${entry.relativePath}` : entry.relativePath) }));
    const valid = items.filter((item): item is { entry: LocalEntry; path: string } => item.path !== null);
    const skipped = entries.length - valid.length;
    if (valid.length === 0) {
      notifyWarning('올릴 수 있는 파일이 없습니다.', `한 파일 ${formatBytes(maxBytes)} 를 넘거나 쓸 수 없는 이름입니다.`);
      return;
    }
    const totalBytes = valid.reduce((sum, item) => sum + item.entry.size, 0);
    const ok = await confirmAction({
      title: isEditor ? `${valid.length}개를 올릴까요?` : `${valid.length}개를 변경 제안으로 올릴까요?`,
      message:
        `${formatBytes(totalBytes)} · ${where} 아래에 내 폴더와 같은 폴더 구조로.` +
        (skipped > 0 ? `\n${skipped}개는 크기 한도(${formatBytes(maxBytes)})를 넘거나 쓸 수 없는 이름이라 뺍니다.` : '') +
        (isEditor ? '' : '\n열람 권한이라 저장소는 그대로이고, 편집자가 제안을 확인한 뒤 반영합니다.'),
      confirmLabel: '올리기',
    });
    if (!ok) return;

    const uploadItems = valid.map((item) => ({ source: item.entry.source, path: item.path }));
    const onProgress = (value: UploadProgress) => setProgress({ label: '올리는 중', value });
    const signal = uploadControl.start();
    try {
      if (isEditor) {
        const { failures, cancelled } = await uploadAndCommit(repoId, uploadItems, onProgress, signal);
        if (cancelled) {
          notify('올리기를 멈췄습니다.', '아무것도 반영하지 않았습니다. 저장소는 그대로입니다.');
          return;
        }
        (failures.length === 0 ? notifySuccess : notifyWarning)(
          failures.length === 0 ? `${uploadItems.length}개를 올렸습니다.` : `${uploadItems.length - failures.length}개 올림, ${failures.length}개 실패`,
          failures.slice(0, 3).map((f) => `${f.item.path}: ${f.message}`).join('\n') || undefined,
        );
      } else {
        const { uploaded, failures, cancelled } = await uploadMany(repoId, uploadItems, onProgress, signal);
        if (cancelled) {
          notify('올리기를 멈췄습니다.', '제안을 만들지 않았습니다.');
          return;
        }
        if (uploaded.length > 0) {
          const { proposal } = await api.createProposal(repoId, {
            title: `내 폴더에서 ${uploaded.length}개 추가`,
            description: `'${folder?.label ?? '내 폴더'}' 와 견줘 저장소에 없던 파일입니다.`,
            changes: uploaded.map(({ item, blob }) => ({ path: item.path, blobHash: blob.hash })),
          });
          setProgress(null);
          if (failures.length > 0) notifyWarning(`${failures.length}개는 올리지 못했습니다.`);
          router.push(`/proposal/${proposal.id}`);
          return;
        }
        notifyError('올리지 못했습니다.', failures.slice(0, 3).map((f) => `${f.item.path}: ${f.message}`).join('\n'));
      }
    } catch (err) {
      notifyError('반영하지 못했습니다.', err instanceof ApiError ? err.message : undefined);
    } finally {
      uploadControl.finish();
      setProgress(null);
    }
    await refresh();
  }

  if (!localFolderSupported) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '내 폴더와 비교' }} />
        <EmptyState
          icon="folder-open-outline"
          title="이 기기에서는 폴더를 고를 수 없습니다"
          description="iOS 는 앱이 폴더를 통째로 고르지 못합니다. PC 앱이나 브라우저, 안드로이드에서 해 주세요."
        />
      </Screen>
    );
  }

  // 옮긴 것으로 짝지은 파일은 "저장소에만"·"내 폴더에만"에서 빼고 "위치만 다름"에 둔다.
  const repoOnly = comparison ? comparison.repoOnly.filter((file) => !movedRepo.has(file.path)) : [];
  const localOnly = comparison ? comparison.localOnly.filter((entry) => !movedLocal.has(entry.relativePath)) : [];
  const counts = comparison
    ? {
        repoOnly: repoOnly.length,
        localOnly: localOnly.length,
        both: comparison.both.length,
        moved: findings?.moved.length ?? 0,
      }
    : null;
  const sizeDiffers = comparison?.both.filter((match) => match.sizeDiffers).length ?? 0;

  type Item = { key: string; label: string; detail: string; size: number; badge?: { label: string; tone: 'warning' | 'success' } };
  const tabItems: Item[] = !comparison
    ? []
    : tab === 'repoOnly'
      ? repoOnly.map((file) => ({ key: keyOfRepo(file), label: file.relativePath, detail: '', size: file.size }))
      : tab === 'localOnly'
        ? localOnly.map((entry) => {
            const existing = alreadyIn.get(entry.relativePath);
            return {
              key: keyOfLocal(entry),
              label: entry.relativePath,
              detail: existing ? `저장소에 같은 내용이 이미 있습니다: ${existing}` : '',
              size: entry.size,
              badge: existing ? { label: '이미 있음', tone: 'success' as const } : undefined,
            };
          })
        : tab === 'moved'
          ? (findings?.moved ?? []).map((pair) => ({
              key: `moved:${pair.local.relativePath}`,
              label: pair.local.relativePath,
              detail: `저장소에서는: ${pair.repo.relativePath}`,
              size: pair.local.size,
            }))
          : comparison.both.map((match) => ({
              key: `both:${match.key}`,
              label: byName ? match.key : match.repo[0].relativePath,
              detail: describeMatch(match.repo, match.local, byName, match.sizeDiffers),
              size: match.repo[0].size,
              badge: findings?.identical.has(match.key)
                ? { label: '내용 같음', tone: 'success' as const }
                : findings?.differs.has(match.key) || match.sizeDiffers
                  ? { label: match.sizeDiffers ? '크기 다름' : '내용 다름', tone: 'warning' as const }
                  : undefined,
            }));
  const selectable = tab !== 'both' && (tab !== 'moved' || isEditor);
  const selectedCount = tabItems.filter((item) => selected.has(item.key)).length;

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = selectable && tabItems.length > 0 && selectedCount === tabItems.length;

  const act = () => {
    if (!comparison) return;
    if (tab === 'repoOnly') void download(repoOnly.filter((file) => selected.has(keyOfRepo(file))));
    if (tab === 'localOnly') void upload(localOnly.filter((entry) => selected.has(keyOfLocal(entry))));
    if (tab === 'moved') void moveInRepo((findings?.moved ?? []).filter((pair) => selected.has(`moved:${pair.local.relativePath}`)));
  };

  /** 옮긴 파일 — 다시 올리지 않고 저장소에서 내 폴더와 같은 위치로 옮긴다. */
  async function moveInRepo(pairs: { local: LocalEntry; repo: RepoFile }[]) {
    if (pairs.length === 0) return;
    const ok = await confirmAction({
      title: `${pairs.length}개를 저장소에서 옮길까요?`,
      message: '내용이 같으니 다시 올리지 않고, 저장소의 파일을 내 폴더와 같은 위치·이름으로 옮깁니다.',
      confirmLabel: '옮기기',
    });
    if (!ok) return;
    const failures: string[] = [];
    for (const pair of pairs) {
      const to = basePath ? `${basePath}/${pair.local.relativePath}` : pair.local.relativePath;
      try {
        await api.movePath(repoId, pair.repo.path, to);
      } catch (err) {
        failures.push(`${pair.repo.relativePath}: ${err instanceof ApiError ? err.message : '옮기지 못했습니다'}`);
      }
    }
    (failures.length === 0 ? notifySuccess : notifyWarning)(
      failures.length === 0 ? `${pairs.length}개를 옮겼습니다.` : `${pairs.length - failures.length}개 옮김, ${failures.length}개 실패`,
      failures.slice(0, 3).join('\n') || undefined,
    );
    await refresh();
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: '내 폴더와 비교' }} />
      <View style={{ gap: spacing.sm }}>
        <Title>내 폴더와 비교</Title>
        <Subtitle>
          기기에서 고른 폴더를 저장소 폴더와 파일 이름으로 견줍니다. "내용으로도 확인"을 켜면 내용까지 봅니다. 폴더는
          비교할 때마다 고르고, 계속 맞춰 두려면 폴더 동기화를 쓰세요.
        </Subtitle>
        <Caption style={{ fontFamily: monoFont }}>
          저장소: {repo ? `${repo.name} / ` : ''}
          {basePath || '(맨 위)'}
        </Caption>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <Card style={{ gap: spacing.md }}>
        {folder ? (
          <View style={{ gap: 2 }}>
            <Caption>내 폴더</Caption>
            <Body numberOfLines={2} style={{ fontFamily: monoFont }}>
              {folder.label}
            </Body>
            <Caption>
              파일 {folder.entries.length}개{folder.truncated ? ' (너무 많아 일부만 훑었습니다 — 없다고 나온 것 중 실제로 있는 것이 섞일 수 있습니다)' : ''}
            </Caption>
          </View>
        ) : (
          <Caption>견줄 폴더를 골라 주세요.</Caption>
        )}
        <Row gap={spacing.sm} wrap>
          <Button
            label={folder ? '다른 폴더 고르기' : '폴더 고르기'}
            icon="folder-open-outline"
            variant={folder ? 'secondary' : 'primary'}
            loading={scanning && !folder}
            disabled={busy}
            onPress={() => void choose()}
          />
          {folder?.rescan ? (
            <Button label="다시 훑기" icon="refresh" variant="secondary" loading={scanning} disabled={busy} onPress={() => void refresh()} />
          ) : null}
        </Row>
        <Pressable
          onPress={() => setByName(!byName)}
          accessibilityRole="switch"
          aria-checked={byName}
          accessibilityLabel="폴더 구조 무시하고 이름만 비교"
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Body>폴더 구조 무시하고 이름만 비교</Body>
            <Caption>
              {byName
                ? '어느 하위 폴더에 있든 이름이 같으면 같은 파일로 봅니다.'
                : '하위 폴더 경로까지 같아야 같은 파일로 봅니다 (앨범/노래.mp3 ↔ 앨범/노래.mp3).'}
            </Caption>
          </View>
          <Switch value={byName} onValueChange={setByName} trackColor={{ true: colors.accent, false: colors.border }} aria-hidden />
        </Pressable>
        <Pressable
          onPress={() => setByContent(!byContent)}
          accessibilityRole="switch"
          aria-checked={byContent}
          accessibilityLabel="내용으로도 확인"
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Body>내용으로도 확인</Body>
            <Caption>
              이름이 같은 파일의 내용이 정말 같은지, 옮기거나 이름만 바꾼 파일이 있는지 봅니다. 크기가 맞는 파일만 읽어
              확인합니다(큰 폴더는 시간이 걸립니다).
            </Caption>
          </View>
          <Switch value={byContent} onValueChange={setByContent} trackColor={{ true: colors.accent, false: colors.border }} aria-hidden />
        </Pressable>
      </Card>

      {progress ? (
        <TransferProgress
          progress={progress.value}
          label={progress.label}
          // 받기는 파일마다 따로라 멈출 것이 없다. 올리기만 멈춘다.
          onCancel={
            progress.label === '올리는 중' ? uploadControl.cancel : progress.label === '내용 확인 중' ? hashControl.cancel : undefined
          }
          cancelling={progress.label === '내용 확인 중' ? hashControl.cancelling : uploadControl.cancelling}
        />
      ) : null}

      {!repoFiles && !error ? <Loading label="저장소 목록 불러오는 중…" /> : null}

      {comparison && counts ? (
        <>
          <Row gap={spacing.xs} wrap>
            <TabChip label={`저장소에만 ${counts.repoOnly}`} active={tab === 'repoOnly'} onPress={() => setTab('repoOnly')} />
            <TabChip label={`내 폴더에만 ${counts.localOnly}`} active={tab === 'localOnly'} onPress={() => setTab('localOnly')} />
            <TabChip
              label={`둘 다 ${counts.both}${
                findings && findings.differs.size > 0
                  ? ` (내용 다름 ${findings.differs.size})`
                  : sizeDiffers
                    ? ` (크기 다름 ${sizeDiffers})`
                    : ''
              }`}
              active={tab === 'both'}
              onPress={() => setTab('both')}
            />
            {byContent ? (
              <TabChip label={`위치만 다름 ${counts.moved}`} active={tab === 'moved'} onPress={() => setTab('moved')} />
            ) : null}
          </Row>
          {byName && comparison.groupedNames > 0 ? (
            <Caption>같은 이름이 여러 곳에 있는 {comparison.groupedNames}개는 "둘 다"에 한데 묶었습니다.</Caption>
          ) : null}

          <Card padded={false}>
            {tabItems.length === 0 ? (
              <EmptyState
                icon="checkmark-done-outline"
                title={
                  tab === 'repoOnly'
                    ? '저장소에만 있는 파일이 없습니다'
                    : tab === 'localOnly'
                      ? '내 폴더에만 있는 파일이 없습니다'
                      : tab === 'moved'
                        ? hashing
                          ? '내용을 확인하는 중입니다'
                          : '위치만 다른 파일이 없습니다'
                        : '겹치는 파일이 없습니다'
                }
              />
            ) : (
              <>
                {selectable ? (
                  <>
                    <Pressable
                      onPress={() => setSelected(allSelected ? new Set() : new Set(tabItems.map((item) => item.key)))}
                      accessibilityRole="checkbox"
                      aria-checked={allSelected}
                      accessibilityLabel="모두 고르기"
                      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg }}
                    >
                      <Ionicons name={allSelected ? 'checkbox' : 'square-outline'} size={20} color={allSelected ? colors.accent : colors.textMuted} />
                      <Body style={{ flex: 1 }}>모두 고르기</Body>
                      <Caption>{selectedCount}개 고름</Caption>
                    </Pressable>
                    <Divider />
                  </>
                ) : null}
                {tabItems.slice(0, shown).map((item, index) => {
                  const checked = selected.has(item.key);
                  return (
                    <View key={item.key}>
                      {index > 0 ? <Divider /> : null}
                      <Pressable
                        onPress={selectable ? () => toggle(item.key) : undefined}
                        disabled={!selectable}
                        accessibilityRole={selectable ? 'checkbox' : undefined}
                        aria-checked={selectable ? checked : undefined}
                        accessibilityLabel={item.label}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing.md,
                          paddingVertical: spacing.sm,
                          paddingHorizontal: spacing.lg,
                        }}
                      >
                        {selectable ? (
                          <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={20} color={checked ? colors.accent : colors.textMuted} />
                        ) : null}
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.text, fontSize: fontSize.sm }}>
                            {item.label}
                          </Text>
                          {item.detail ? <Caption numberOfLines={2}>{item.detail}</Caption> : null}
                        </View>
                        {item.badge ? <Badge label={item.badge.label} tone={item.badge.tone} /> : null}
                        <Caption>{formatBytes(item.size)}</Caption>
                      </Pressable>
                    </View>
                  );
                })}
                {tabItems.length > shown ? (
                  <>
                    <Divider />
                    <View style={{ padding: spacing.md }}>
                      <Button label={`${tabItems.length - shown}개 더 보기`} variant="ghost" compact onPress={() => setShown(shown + PAGE)} />
                    </View>
                  </>
                ) : null}
              </>
            )}
          </Card>

          {tab === 'repoOnly' ? (
            <Button
              label={selectedCount > 0 ? `고른 ${selectedCount}개 ${folder?.save ? '내 폴더로 받기' : '받기'}` : '받을 파일을 고르세요'}
              icon="download-outline"
              full
              disabled={selectedCount === 0 || busy}
              onPress={act}
            />
          ) : null}
          {tab === 'localOnly' ? (
            <Button
              label={
                selectedCount > 0
                  ? `고른 ${selectedCount}개 ${isEditor ? '저장소에 올리기' : '변경 제안으로 올리기'}`
                  : '올릴 파일을 고르세요'
              }
              icon="cloud-upload-outline"
              full
              disabled={selectedCount === 0 || busy}
              onPress={act}
            />
          ) : null}
          {tab === 'moved' ? (
            isEditor ? (
              <Button
                label={selectedCount > 0 ? `고른 ${selectedCount}개 저장소에서 옮기기` : '옮길 파일을 고르세요'}
                icon="move-outline"
                full
                disabled={selectedCount === 0 || busy}
                onPress={act}
              />
            ) : (
              <Caption>내용은 같고 위치나 이름만 다릅니다. 저장소에서 옮기는 것은 편집 권한이 있는 멤버가 할 수 있습니다.</Caption>
            )
          ) : null}
          {tab === 'repoOnly' && folder && !folder.save ? (
            <Caption>
              브라우저는 고른 폴더에 쓸 수 없어 브라우저의 내려받기 폴더로 받습니다. 폴더에 바로 넣으려면 PC 앱이나
              안드로이드 앱을 쓰세요.
            </Caption>
          ) : null}
          {Platform.OS === 'web' && folder && !folder.rescan ? (
            <Caption>받거나 올린 뒤 결과를 다시 보려면 폴더를 다시 고르세요.</Caption>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function describeMatch(repo: RepoFile[], local: LocalEntry[], byName: boolean, sizeDiffers: boolean): string {
  const parts: string[] = [];
  if (byName) {
    parts.push(`저장소: ${repo.map((file) => file.relativePath).join(', ')}`);
    parts.push(`내 폴더: ${local.map((entry) => entry.relativePath).join(', ')}`);
  }
  if (sizeDiffers) {
    parts.push(`크기 다름 — 저장소 ${repo.map((file) => formatBytes(file.size)).join(', ')} · 내 폴더 ${local.map((entry) => formatBytes(entry.size)).join(', ')}`);
  }
  return parts.join('\n');
}

function TabChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={label}
      style={{
        paddingVertical: spacing.xs + 2,
        paddingHorizontal: spacing.md,
        borderRadius: 999,
        backgroundColor: active ? colors.accentSoft : colors.surfaceAlt,
      }}
    >
      <Text style={{ color: active ? colors.accent : colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
