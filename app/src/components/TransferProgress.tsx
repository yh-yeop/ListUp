import { useRef, useState } from 'react';
import { View } from 'react-native';
import { formatBytes } from '@listup/shared';
import { confirmAction } from '../lib/dialogs';
import type { UploadProgress } from '../lib/transfer';
import { radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption, Card, Row } from './ui';

/** 진행 중인 전송을 멈추는 수단. 전송마다 begin() 으로 새 signal 을 받는다. */
export interface TransferControl {
  /** 새 전송을 시작한다 — 이 signal 을 전송 함수에 넘긴다. */
  begin(): AbortSignal;
  /** 멈출지 물은 뒤 멈춘다. */
  cancel(): Promise<void>;
  /** 멈추라고 했고, 전송이 아직 끝나지 않았다. */
  cancelling: boolean;
}

/**
 * 전송 멈추기. message 는 멈출지 물을 때 무엇이 남고 무엇이 사라지는지 알려 주는 문구.
 * 멈춰도 올리던 파일 하나만 끊긴다 — 그때까지 끝난 파일을 어떻게 할지는 부른 화면이 정한다.
 */
export function useTransferControl(message: string): TransferControl {
  const controller = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  return {
    begin() {
      controller.current = new AbortController();
      setCancelling(false);
      return controller.current.signal;
    },
    async cancel() {
      const current = controller.current;
      if (!current || current.signal.aborted) return;
      const ok = await confirmAction({ title: '멈출까요?', message, confirmLabel: '멈추기', destructive: true });
      if (!ok || controller.current !== current) return;
      setCancelling(true);
      current.abort();
    },
    cancelling,
  };
}

/** 올리는 중인 진행률 — 몇 번째 파일인지, 전체 몇 %인지, 지금 파일 이름. control 을 주면 멈추기 버튼. */
export function TransferProgress({
  progress,
  label = '올리는 중',
  control,
}: {
  progress: UploadProgress;
  label?: string;
  control?: TransferControl;
}) {
  const { colors } = useTheme();
  const fraction = progress.totalBytes > 0 ? Math.min(1, progress.sentBytes / progress.totalBytes) : 1;
  const percent = Math.floor(fraction * 100);
  const fileIndex = Math.min(progress.doneFiles + 1, progress.totalFiles);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
        <Body style={{ fontWeight: '600' }}>
          {control?.cancelling ? '멈추는 중' : label} · {fileIndex}/{progress.totalFiles}
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
      <Row style={{ justifyContent: 'space-between' }} gap={spacing.md}>
        <Caption numberOfLines={1} style={{ flex: 1 }}>
          {progress.current ? `${progress.current} · ` : ''}
          {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)}
        </Caption>
        {control ? (
          <Button
            label="멈추기"
            icon="stop-circle-outline"
            variant="secondary"
            compact
            loading={control.cancelling}
            disabled={control.cancelling}
            onPress={() => void control.cancel()}
          />
        ) : null}
      </Row>
    </Card>
  );
}
