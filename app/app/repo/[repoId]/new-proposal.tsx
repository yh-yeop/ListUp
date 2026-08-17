import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatBytes, normalizePath, type TreeListing } from '@listup/shared';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  ErrorNotice,
  Field,
  IconButton,
  Input,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { ApiError, api } from '../../../src/api/client';
import { notify } from '../../../src/lib/dialogs';
import { pickFiles } from '../../../src/lib/files';
import { useAsync } from '../../../src/lib/useAsync';
import { fontSize, monoFont, spacing, useTheme } from '../../../src/theme';

/** 화면에서 준비 중인 변경 한 건. */
interface StagedChange {
  key: string;
  path: string;
  /** null 이면 삭제 제안. */
  blobHash: string | null;
  size: number;
  originalName: string;
}

export default function NewProposalScreen() {
  const { repoId, path: initialPath } = useLocalSearchParams<{ repoId: string; path?: string }>();
  const { colors } = useTheme();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [staged, setStaged] = useState<StagedChange[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState(initialPath ?? '');

  // 삭제 제안을 고르기 위해 현재 저장소 내용을 보여준다.
  const treeState = useAsync<TreeListing>(
    async () => (await api.listFiles(repoId, browsePath)).tree,
    [repoId, browsePath],
  );

  const currentFolder = initialPath ?? '';

  async function addFiles() {
    if (uploading) return;
    let sources;
    try {
      sources = await pickFiles(true);
    } catch {
      notify('파일을 선택하지 못했습니다.');
      return;
    }
    if (sources.length === 0) return;

    setUploading(true);
    setError(null);
    const added: StagedChange[] = [];
    for (const source of sources) {
      try {
        // 제안용 blob 은 미리 올려 둔다. 저장소 내용은 아직 그대로다.
        const { blob } = await api.uploadBlob(repoId, source);
        added.push({
          key: `${blob.hash}:${source.name}:${added.length}`,
          path: currentFolder ? `${currentFolder}/${source.name}` : source.name,
          blobHash: blob.hash,
          size: blob.size,
          originalName: source.name,
        });
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : `${source.name} 을(를) 올리지 못했습니다.`,
        );
      }
    }
    setStaged((prev) => [...prev, ...added]);
    setUploading(false);
  }

  function stageDeletion(filePath: string) {
    setStaged((prev) => {
      if (prev.some((change) => change.path === filePath)) return prev;
      return [
        ...prev,
        {
          key: `delete:${filePath}`,
          path: filePath,
          blobHash: null,
          size: 0,
          originalName: filePath,
        },
      ];
    });
  }

  function updatePath(key: string, nextPath: string) {
    setStaged((prev) =>
      prev.map((change) => (change.key === key ? { ...change, path: nextPath } : change)),
    );
  }

  function removeStaged(key: string) {
    setStaged((prev) => prev.filter((change) => change.key !== key));
  }

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError('제안 제목을 입력해 주세요.');
      return;
    }
    if (staged.length === 0) {
      setError('바꿀 파일을 하나 이상 담아 주세요.');
      return;
    }

    const seen = new Set<string>();
    for (const change of staged) {
      const normalized = normalizePath(change.path);
      if (!normalized) {
        setError(`경로가 올바르지 않습니다: ${change.path || '(빈 값)'}`);
        return;
      }
      if (seen.has(normalized)) {
        setError(`같은 경로가 두 번 들어 있습니다: ${normalized}`);
        return;
      }
      seen.add(normalized);
    }

    setSubmitting(true);
    try {
      const { proposal } = await api.createProposal(repoId, {
        title: title.trim(),
        description: description.trim() || undefined,
        changes: staged.map((change) => ({
          path: normalizePath(change.path)!,
          blobHash: change.blobHash,
        })),
      });
      router.replace(`/proposal/${proposal.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '제안을 만들지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: '변경 제안 만들기' }} />

      <View style={{ gap: spacing.sm }}>
        <Title>변경 제안 만들기</Title>
        <Subtitle>
          담은 내용은 바로 반영되지 않습니다. 편집 권한이 있는 멤버가 확인한 뒤 병합합니다.
        </Subtitle>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <Card style={{ gap: spacing.lg }}>
        <Field label="제목">
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder="예: 3월 회의록 오타 수정"
            maxLength={120}
          />
        </Field>
        <Field label="설명" hint="선택 사항 — 무엇을 왜 바꿨는지 적어 두면 검토가 빨라집니다.">
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder="바꾼 이유를 적어 주세요."
            multiline
            style={{ minHeight: 88, textAlignVertical: 'top' }}
          />
        </Field>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Body style={{ fontWeight: '600' }}>담은 변경 ({staged.length})</Body>
          <Button
            label="파일 담기"
            icon="add"
            compact
            onPress={addFiles}
            loading={uploading}
          />
        </Row>

        {staged.length === 0 ? (
          <Caption>
            올릴 파일을 담거나, 아래 목록에서 지우고 싶은 파일을 선택하세요. 같은 경로에 기존 파일이
            있으면 수정으로, 없으면 추가로 처리됩니다.
          </Caption>
        ) : (
          <View style={{ gap: spacing.md }}>
            {staged.map((change) => (
              <View key={change.key} style={{ gap: spacing.xs }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={spacing.sm} style={{ flex: 1 }}>
                    <Badge
                      label={change.blobHash === null ? '삭제' : '올림'}
                      tone={change.blobHash === null ? 'danger' : 'accent'}
                    />
                    <Caption numberOfLines={1} style={{ flex: 1 }}>
                      {change.originalName}
                      {change.blobHash !== null ? ` · ${formatBytes(change.size)}` : ''}
                    </Caption>
                  </Row>
                  <IconButton
                    icon="close"
                    label="이 변경 빼기"
                    onPress={() => removeStaged(change.key)}
                  />
                </Row>
                {change.blobHash === null ? (
                  <Body style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>{change.path}</Body>
                ) : (
                  <Input
                    value={change.path}
                    onChangeText={(value) => updatePath(change.key, value)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="저장할 경로 (예: 문서/회의록.md)"
                    style={{ fontFamily: monoFont, fontSize: fontSize.sm }}
                  />
                )}
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card padded={false} style={{ paddingVertical: spacing.md }}>
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.xs, marginBottom: spacing.sm }}>
          <Body style={{ fontWeight: '600' }}>저장소에 있는 파일</Body>
          <Caption>
            {browsePath === '' ? '최상위 폴더' : browsePath} — 지우고 싶은 파일을 눌러 담을 수
            있습니다.
          </Caption>
        </View>

        {browsePath !== '' ? (
          <Pressable
            onPress={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
            }}
          >
            <Ionicons name="arrow-up" size={18} color={colors.textMuted} />
            <Caption>상위 폴더로</Caption>
          </Pressable>
        ) : null}

        {treeState.loading ? (
          <Loading label="목록 불러오는 중…" />
        ) : treeState.error ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <ErrorNotice message={treeState.error} onRetry={treeState.reload} />
          </View>
        ) : treeState.data ? (
          <>
            {treeState.data.dirs.map((dir) => (
              <Pressable
                key={dir.path}
                onPress={() => setBrowsePath(dir.path)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                })}
              >
                <Ionicons name="folder" size={18} color={colors.accent} />
                <Body style={{ flex: 1 }} numberOfLines={1}>
                  {dir.name}
                </Body>
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </Pressable>
            ))}

            {treeState.data.files.map((file) => {
              const alreadyStaged = staged.some((change) => change.path === file.path);
              return (
                <View key={file.path}>
                  <Divider />
                  <Pressable
                    onPress={() => stageDeletion(file.path)}
                    disabled={alreadyStaged}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.md,
                      opacity: alreadyStaged ? 0.5 : 1,
                      backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
                    })}
                  >
                    <Ionicons name="document-outline" size={18} color={colors.textMuted} />
                    <View style={{ flex: 1 }}>
                      <Body numberOfLines={1}>{file.name}</Body>
                      <Caption>{formatBytes(file.size)}</Caption>
                    </View>
                    {alreadyStaged ? (
                      <Caption>담김</Caption>
                    ) : (
                      <Caption style={{ color: colors.danger }}>삭제 담기</Caption>
                    )}
                  </Pressable>
                </View>
              );
            })}

            {treeState.data.dirs.length === 0 && treeState.data.files.length === 0 ? (
              <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>
                <Caption>이 폴더에는 파일이 없습니다.</Caption>
              </View>
            ) : null}
          </>
        ) : null}
      </Card>

      <Button
        label={`제안 올리기 (${staged.length}개 변경)`}
        onPress={submit}
        loading={submitting}
        disabled={staged.length === 0 || !title.trim()}
        full
      />
    </Screen>
  );
}
