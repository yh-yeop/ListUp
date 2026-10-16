import { View } from 'react-native';
import { formatBytes } from '@listup/shared';
import type { UploadProgress } from '../lib/transfer';
import { radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption, Card } from './ui';

/**
 * 올리는 중인 진행률 — 몇 번째 파일인지, 전체 몇 %인지, 지금 파일 이름.
 * `onCancel` 을 주면 멈추기 버튼을 단다. 멈추는 중(`cancelling`)에는 버튼이 돈다.
 */
export function TransferProgress({
  progress,
  label = '올리는 중',
  onCancel,
  cancelling = false,
}: {
  progress: UploadProgress;
  label?: string;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const { colors } = useTheme();
  const fraction = progress.totalBytes > 0 ? Math.min(1, progress.sentBytes / progress.totalBytes) : 1;
  const percent = Math.floor(fraction * 100);
  const fileIndex = Math.min(progress.doneFiles + 1, progress.totalFiles);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
        <Body style={{ fontWeight: '600' }}>
          {label} · {fileIndex}/{progress.totalFiles}
        </Body>
        <Body muted>{percent}%</Body>
      </View>
      <View
        accessibilityRole="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${label} ${percent}%`}
        style={{ height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}
      >
        <View style={{ width: `${percent}%`, height: '100%', backgroundColor: colors.accent }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
        <Caption numberOfLines={1} style={{ flex: 1 }}>
          {progress.current ? `${progress.current} · ` : ''}
          {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)}
        </Caption>
        {onCancel ? (
          <Button
            label={cancelling ? '멈추는 중' : '멈추기'}
            icon="stop-circle-outline"
            variant="secondary"
            compact
            onPress={onCancel}
            loading={cancelling}
            disabled={cancelling}
          />
        ) : null}
      </View>
    </Card>
  );
}
