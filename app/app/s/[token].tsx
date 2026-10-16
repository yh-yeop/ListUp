import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { formatBytes, formatDate, type PublicShare } from '@listup/shared';
import {
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
  Subtitle,
  Title,
} from '../../src/components/ui';
import { TransferProgress } from '../../src/components/TransferProgress';
import { ApiError, publicShareApi, type UploadSource } from '../../src/api/client';
import { notifyError } from '../../src/lib/dialogs';
import { pickFiles } from '../../src/lib/files';
import { uploadMany, type UploadProgress, type UploadTarget } from '../../src/lib/transfer';
import { useAbortable } from '../../src/lib/useAbortable';
import { useAsync } from '../../src/lib/useAsync';
import { useAuth } from '../../src/state/auth';
import { serverUrl } from '../../src/state/servers';
import { fontSize, monoFont, spacing, useTheme } from '../../src/theme';

/**
 * 공개 링크를 연 사람의 화면 — 로그인 없이. 서버가 주는 웹에서 열린다(`<서버>/s/<토큰>`).
 * - 받기 링크: 파일 목록과 받기, 폴더면 zip
 * - 받기 함: 이름·메시지를 적고 파일을 보낸다 → 저장소에는 변경 제안으로 들어간다
 */
export default function PublicShareScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { activeServer } = useAuth();
  // 링크는 서버가 주는 웹에서 열리므로 지금 페이지 주소가 곧 서버다. 앱 안에서 열렸다면 지금 서버.
  const base =
    Platform.OS === 'web' ? window.location.origin : activeServer ? serverUrl(activeServer).replace(/\/+$/, '') : '';
  const client = useMemo(() => publicShareApi(base, token), [base, token]);
  const state = useAsync<PublicShare>(async () => (await client.info()).share, [client]);
  const share = state.data;

  return (
    <Screen>
      <Stack.Screen options={{ title: share?.label || 'ListUp' }} />
      {state.loading && !share ? (
        <Loading />
      ) : state.error ? (
        <Card style={{ gap: spacing.sm }}>
          <Title>링크를 열 수 없습니다</Title>
          <ErrorNotice message={state.error} />
          <Caption>링크를 준 사람에게 새 링크를 부탁해 주세요.</Caption>
        </Card>
      ) : share ? (
        <>
          <View style={{ gap: spacing.sm }}>
            <Caption>ListUp · {share.repoName}</Caption>
            <Title>{share.label || (share.kind === 'upload' ? '파일 보내기' : share.name || share.repoName)}</Title>
            <Subtitle>
              {share.kind === 'upload'
                ? '로그인 없이 파일을 보낼 수 있습니다. 보낸 파일은 받는 쪽에서 확인한 뒤 저장소에 넣습니다.'
                : '로그인 없이 받을 수 있습니다.'}
              {share.expiresAt ? ` ${formatDate(share.expiresAt)} 까지 열립니다.` : ''}
            </Subtitle>
          </View>
          {share.kind === 'download' ? <DownloadView share={share} client={client} /> : <UploadView share={share} client={client} />}
        </>
      ) : null}
    </Screen>
  );
}

type Client = ReturnType<typeof publicShareApi>;

/** 파일 받기 — 브라우저가 직접 받는다(이어받기·진행률은 브라우저가). */
function startDownload(url: string) {
  if (Platform.OS !== 'web') return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function DownloadView({ share, client }: { share: PublicShare; client: Client }) {
  const { colors } = useTheme();
  const files = share.files ?? [];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return (
    <>
      {!share.isFile && files.length > 1 ? (
        <Button label={`모두 zip 으로 받기 (${files.length}개 · ${formatBytes(total)})`} icon="archive-outline" onPress={() => startDownload(client.zipUrl())} />
      ) : null}
      <Card padded={false} style={{ paddingVertical: spacing.sm }}>
        {files.map((file, index) => (
          <View key={file.path || 'file'}>
            {index > 0 ? <Divider /> : null}
            <Row gap={spacing.md} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>
              <Ionicons name="document-outline" size={20} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Body numberOfLines={1}>{file.path || share.name}</Body>
                <Caption>{formatBytes(file.size)}</Caption>
              </View>
              <Button
                label="받기"
                icon="download-outline"
                variant="secondary"
                compact
                onPress={() => startDownload(client.fileUrl(file.path))}
              />
            </Row>
          </View>
        ))}
      </Card>
    </>
  );
}

function UploadView({ share, client }: { share: PublicShare; client: Client }) {
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<UploadSource[]>([]);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string[] | null>(null);
  const control = useAbortable();
  const total = picked.reduce((sum, file) => sum + file.size, 0);
  const tooBig = picked.filter((file) => share.maxFileBytes !== undefined && file.size > share.maxFileBytes);
  const overQuota = share.remainingBytes !== null && share.remainingBytes !== undefined && total > share.remainingBytes;

  const target: UploadTarget = {
    start: (payload) => client.startUpload(payload),
    putChunk: (id, offset, bytes, onProgress, signal) => client.putChunk(id, offset, bytes, onProgress, signal),
    getUpload: (id) => client.getUpload(id),
    complete: (id) => client.completeUpload(id),
    cancel: (id) => client.cancelUpload(id),
  };

  async function choose() {
    try {
      const sources = await pickFiles(true);
      if (sources.length > 0) setPicked((prev) => [...prev, ...sources]);
    } catch {
      notifyError('파일을 고르지 못했습니다.');
    }
  }

  async function send() {
    setError(null);
    const signal = control.start();
    setProgress({ sentBytes: 0, totalBytes: total, doneFiles: 0, totalFiles: picked.length, current: '' });
    try {
      const outcome = await uploadMany(
        target,
        picked.map((source) => ({ source, path: source.relativePath ?? source.name })),
        setProgress,
        signal,
      );
      if (outcome.cancelled) return;
      if (outcome.uploaded.length === 0) {
        setError(outcome.failures[0]?.message ?? '보내지 못했습니다.');
        return;
      }
      const result = await client.submit({
        name: name.trim(),
        message: message.trim() || undefined,
        files: outcome.uploaded.map(({ item, blob }) => ({ path: item.path, blobHash: blob.hash })),
      });
      setSent(result.files);
      if (outcome.failures.length > 0) setError(`${outcome.failures.length}개는 보내지 못했습니다: ${outcome.failures[0].message}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '보내지 못했습니다.');
    } finally {
      control.finish();
      setProgress(null);
    }
  }

  if (sent) {
    return (
      <Card style={{ gap: spacing.md }}>
        <Row gap={spacing.sm}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Body style={{ fontWeight: '600' }}>보냈습니다</Body>
        </Row>
        <Caption>받는 쪽에서 확인한 뒤 저장소에 넣습니다. {sent.length}개:</Caption>
        {sent.slice(0, 20).map((path) => (
          <Caption key={path} style={{ fontFamily: monoFont }}>
            {path}
          </Caption>
        ))}
        {error ? <ErrorNotice message={error} /> : null}
        <Button
          label="더 보내기"
          variant="secondary"
          onPress={() => {
            setSent(null);
            setPicked([]);
            setError(null);
          }}
        />
      </Card>
    );
  }

  return (
    <Card style={{ gap: spacing.lg }}>
      <Field label="보내는 사람" hint="받는 쪽에 보입니다.">
        <Input value={name} onChangeText={setName} maxLength={40} placeholder="이름" />
      </Field>
      <Field label="메시지" hint="선택 사항">
        <Input value={message} onChangeText={setMessage} maxLength={2000} multiline placeholder="무엇을 보내는지 적어 주세요." />
      </Field>
      <View style={{ gap: spacing.xs }}>
        <Button label="파일 고르기" icon="add" variant="secondary" onPress={() => void choose()} disabled={progress !== null} />
        {picked.map((file, index) => (
          <Row key={`${file.name}-${index}`} gap={spacing.sm}>
            <Caption style={{ flex: 1, fontSize: fontSize.sm }} numberOfLines={1}>
              {file.relativePath ?? file.name}
            </Caption>
            <Caption>{formatBytes(file.size)}</Caption>
          </Row>
        ))}
        {picked.length > 0 ? <Caption>모두 {picked.length}개 · {formatBytes(total)}</Caption> : null}
        {share.remainingBytes !== null && share.remainingBytes !== undefined ? (
          <Caption>이 받기 함에 남은 용량: {formatBytes(share.remainingBytes)}</Caption>
        ) : null}
      </View>
      {tooBig.length > 0 ? <ErrorNotice message={`너무 큰 파일이 있습니다: ${tooBig.map((f) => f.name).join(', ')}`} /> : null}
      {overQuota ? <ErrorNotice message="남은 용량보다 많이 골랐습니다." /> : null}
      {error ? <ErrorNotice message={error} /> : null}
      {progress ? (
        <TransferProgress progress={progress} label="보내는 중" onCancel={control.cancel} cancelling={control.cancelling} />
      ) : null}
      <Button
        label={picked.length > 0 ? `${picked.length}개 보내기` : '보내기'}
        icon="send-outline"
        onPress={() => void send()}
        loading={progress !== null}
        disabled={!name.trim() || picked.length === 0 || tooBig.length > 0 || overQuota}
      />
    </Card>
  );
}
