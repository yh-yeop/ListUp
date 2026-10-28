import { PROPOSAL_STATUS_LABEL, type ProposalStatus } from '@listup/shared';
import { Badge } from './ui';

const STATUS_TONE: Record<ProposalStatus, 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  merged: 'success',
  closed: 'neutral',
};

const STATUS_ICON: Record<ProposalStatus, 'ellipse-outline' | 'checkmark-circle' | 'close-circle'> = {
  open: 'ellipse-outline',
  merged: 'checkmark-circle',
  closed: 'close-circle',
};

/** 제안 상태 배지 — 제안 목록·내 제안이 같은 색과 아이콘을 쓴다. */
export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return <Badge label={PROPOSAL_STATUS_LABEL[status]} tone={STATUS_TONE[status]} icon={STATUS_ICON[status]} />;
}
