import { View } from 'react-native';
import { formatBytes } from '@listup/shared';
import type { UploadProgress } from '../lib/transfer';
import { radius, spacing, useTheme } from '../theme';
import { Body, Caption, Card } from './ui';

/** 올리는 중인 진행률 — 몇 번째 파일인지, 전체 몇 %인지, 지금 파일 이름. */
export function TransferProgress({ progress, label = '올리는 중' }: { progress: UploadProgress; label?: string }) {
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
      <Caption numberOfLines={1}>
        {progress.current ? `${progress.current} · ` : ''}
        {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)}
      </Caption>
    </Card>
  );
}
