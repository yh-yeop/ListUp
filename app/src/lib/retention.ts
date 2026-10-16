import type { HistoryKeepOlder } from '@listup/shared';

const KEEP_LABEL: Record<HistoryKeepOlder, string> = {
  none: '',
  daily: '하루에 하나씩',
  weekly: '한 주에 하나씩',
  monthly: '한 달에 하나씩',
};

/** 서버의 이력 보존 설정을 한 줄로. 설정을 모르면(옛 서버) 모두 남긴다고 본다. */
export function describeRetention(retention: { days: number; keepOlder: HistoryKeepOlder } | undefined): string {
  if (!retention || retention.days <= 0) return '이 서버는 변경 이력을 모두 남깁니다.';
  const older =
    retention.keepOlder === 'none'
      ? '그보다 오래된 시점은 정리됩니다'
      : `그보다 오래된 시점은 ${KEEP_LABEL[retention.keepOlder]} 남깁니다`;
  return `최근 ${retention.days}일의 시점은 모두 남기고, ${older}. 지금 파일은 늘 남습니다.`;
}
