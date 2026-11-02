import { View } from 'react-native';
import { formatBytes } from '@listup/shared';
import { canCancel, phaseLabel } from '../lib/pure/transfer-report';
import { cancelTransfer, type TransferJob } from '../lib/transfer-store';
import { radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption, Card, Row } from './ui';

/**
 * 전송 하나의 진행 카드 — 몇 번째 파일인지, 전체 몇 %인지, 지금 파일 이름, 멈추기. footnote 는 맨 아래 한 줄.
 * 상태는 lib/transfer-store.ts 에 있고 이 카드는 그리기만 한다(루트의 TransferHost 가 쓴다).
 *
 * progressbar 이름은 단계와 상관없이 `${label} ${percent}%` 로 고정한다 — e2e 가 `/^올리는 중/` 으로 찾는다.
 * 제목 글자만 단계(마무리·반영)와 멈추는 중을 따라 바뀐다.
 */
export function TransferProgress({ job, footnote }: { job: TransferJob; footnote?: string }) {
  const { colors } = useTheme();
  const { progress } = job;
  const fraction = progress.totalBytes > 0 ? Math.min(1, progress.sentBytes / progress.totalBytes) : 1;
  const percent = Math.floor(fraction * 100);
  const fileIndex = Math.min(progress.doneFiles + 1, progress.totalFiles);
  const title = job.cancelling ? '멈추는 중' : phaseLabel(progress.phase, job.label);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
        <Body style={{ fontWeight: '600' }}>
          {title} · {fileIndex}/{progress.totalFiles}
        </Body>
        <Body muted>{percent}%</Body>
      </View>
      <View
        accessibilityRole="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${job.label} ${percent}%`}
        style={{ height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}
      >
        <View style={{ width: `${percent}%`, height: '100%', backgroundColor: colors.accent }} />
      </View>
      <Row style={{ justifyContent: 'space-between' }} gap={spacing.md}>
        <Caption numberOfLines={1} style={{ flex: 1 }}>
          {progress.current ? `${progress.current} · ` : ''}
          {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)}
        </Caption>
        {canCancel(progress) ? (
          <Button
            label="멈추기"
            icon="stop-circle-outline"
            variant="secondary"
            compact
            loading={job.cancelling}
            disabled={job.cancelling}
            onPress={() => void cancelTransfer(job.id)}
          />
        ) : null}
      </Row>
      {footnote ? <Caption>{footnote}</Caption> : null}
    </Card>
  );
}
