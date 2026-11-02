/**
 * 전송 진행·결과를 사람에게 보일 말로 — 플랫폼 import 가 없는 순수 함수(app/test 가 node 에서 바로 불러
 * 검사한다). 진행 카드(components/TransferProgress.tsx)와 올리기 화면이 쓴다.
 */

/**
 * 전송의 단계. sending 은 조각을 보내는 중, finishing 은 마지막 조각을 보낸 뒤 서버가 파일을 맞춰 보는 중
 * (complete — 큰 파일은 해시에 시간이 걸린다), committing 은 다 올린 뒤 커밋·제안을 만드는 중.
 */
export type TransferPhase = 'sending' | 'finishing' | 'committing';

/** 단계 판정에 쓰는 진행 정보. phase 가 없으면 sending 으로 본다. */
export interface PhasedProgress {
  phase?: TransferPhase;
  /** 다 올린 파일 수 */
  doneFiles: number;
  totalFiles: number;
}

/**
 * 멈추기 버튼을 보일지. 커밋 중이나 마지막 파일을 마무리하는 중에 멈추면 다 보낸 것을 버리게 되거나
 * 서버는 이미 반영했는데 화면만 「멈췄습니다」가 되므로 막는다. 중간 파일의 마무리는 멈춰도 그 뒤 파일만 안 보낸다.
 * 파일을 다 보내고 커밋으로 넘어가기 직전(보내는 중인데 남은 파일이 없음)도 멈출 것이 없다.
 */
export function canCancel(progress: PhasedProgress): boolean {
  switch (progress.phase ?? 'sending') {
    case 'sending':
      return progress.totalFiles === 0 || progress.doneFiles < progress.totalFiles;
    case 'finishing':
      return progress.doneFiles + 1 < progress.totalFiles;
    default:
      return false;
  }
}

/** 진행 카드 제목. sendingLabel 은 화면이 붙인 이름(올리는 중·담는 중·받는 중), committingLabel 은 커밋이냐 제안이냐. */
export function phaseLabel(
  phase: TransferPhase | undefined,
  sendingLabel: string,
  committingLabel = '반영하는 중',
): string {
  switch (phase ?? 'sending') {
    case 'finishing':
      return '서버에서 마무리하는 중';
    case 'committing':
      return committingLabel;
    default:
      return sendingLabel;
  }
}

/** 토스트 한 장 — 화면은 notify(title, message, tone) 로 그대로 띄운다. */
export interface Notice {
  tone: 'info' | 'success' | 'error';
  title: string;
  message?: string;
}

/** 올리고 커밋까지 한 결과의 요약. */
export interface UploadSummary {
  /** 올리려던 파일 수 */
  total: number;
  /** 다 올린 파일 수 */
  uploaded: number;
  /** 올리지 못한 파일 이름과 이유 */
  failures: { name: string; message: string }[];
  /** 사용자가 도중에 멈췄다 */
  cancelled: boolean;
  /** 연결이 오래 끊겨 그만뒀다(lib/transfer.ts TransferOffline). 끊긴 파일의 세션은 서버와 기기에 남아 있다. */
  offline?: boolean;
  /** 커밋 결과. 하나도 못 올렸으면 null */
  commit: { added: number; updated: number } | null;
}

/** 실패 안내에 나열할 최대 건수. 나머지는 'n건 더' 로 줄인다. */
export const MAX_FAILURES_SHOWN = 3;

/** 연결이 끊겨 그만뒀을 때 덧붙이는 안내 — 같은 파일을 다시 고르면 기억해 둔 세션에 이어 보낸다. */
export const OFFLINE_HINT = '연결되면 같은 파일을 다시 올리세요. 받은 데서 이어 갑니다.';

/**
 * 파일 화면에서 올리고 커밋한 결과를 토스트 하나로. 1개를 그대로 올린 것처럼 목록만 봐도 알 수 있으면 null
 * (토스트 없음). 멈춘 경우의 제목 `멈췄습니다 — N/M개 올림` 은 e2e(10-polish)가 그대로 찾는다.
 * 연결이 끊겨 그만둔 경우는 `연결이 끊겼습니다 — N/M개 올림` 과 다시 올리면 이어 간다는 안내.
 */
export function describeUploadOutcome(summary: UploadSummary): Notice | null {
  const { total, uploaded, failures, cancelled, offline, commit } = summary;
  if (cancelled) {
    return {
      tone: 'info',
      title: `멈췄습니다 — ${uploaded}/${total}개 올림`,
      message:
        uploaded > 0 ? '다 올린 파일은 저장소에 반영했습니다. 나머지는 올리지 않았습니다.' : '저장소는 그대로입니다.',
    };
  }
  if (offline) {
    return {
      tone: 'error',
      title: `연결이 끊겼습니다 — ${uploaded}/${total}개 올림`,
      message: uploaded > 0 && commit ? `다 올린 파일은 저장소에 반영했습니다.
${OFFLINE_HINT}` : OFFLINE_HINT,
    };
  }
  if (failures.length > 0) {
    const shown = failures.slice(0, MAX_FAILURES_SHOWN).map((f) => `${f.name}: ${f.message}`);
    const more = failures.length - shown.length;
    return {
      tone: 'error',
      title: `${uploaded}개 올렸습니다.`,
      message: `${failures.length}개는 올리지 못했습니다.\n${shown.join('\n')}${more > 0 ? `\n외 ${more}건 더` : ''}`,
    };
  }
  if (commit && total > 1) {
    const parts = [commit.added ? `추가 ${commit.added}` : '', commit.updated ? `수정 ${commit.updated}` : ''].filter(
      Boolean,
    );
    if (parts.length > 0) return { tone: 'success', title: `${total}개 올렸습니다 — ${parts.join(' · ')}` };
    return { tone: 'info', title: '바뀐 파일이 없습니다.', message: '올린 파일이 저장소에 있는 것과 같습니다.' };
  }
  return null;
}

/** 서버 오류처럼 보이는 것(ApiError 의 모양) — 이 파일은 api/client 를 값으로 불러오지 않는다. */
interface ServerErrorLike {
  status: number;
  message: string;
  details?: unknown;
}

function asServerError(err: unknown): ServerErrorLike | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, message } = err as Partial<ServerErrorLike>;
  return typeof status === 'number' && typeof message === 'string' ? (err as ServerErrorLike) : null;
}

/**
 * 다 올린 뒤 커밋(제안)을 못 했을 때의 토스트. 올린 파일이 저장소에 없다는 것을 제목에 분명히 하고, 서버 메시지와
 * 이름이 겹친 경로(서버가 details.conflicts 로 주면, 메시지에 이미 없는 것만 MAX_FAILURES_SHOWN 개)를 붙인다.
 * 서버 오류가 아니면(코드 오류 따위) 제목만.
 */
export function describeCommitFailure(
  err: unknown,
  uploadedCount: number,
  target: 'commit' | 'proposal' = 'commit',
): Notice {
  const title =
    target === 'proposal'
      ? `제안을 만들지 못했습니다 — 올린 ${uploadedCount}개는 제안에 담기지 않았습니다.`
      : `반영하지 못했습니다 — 올린 ${uploadedCount}개는 반영되지 않았습니다.`;
  const server = asServerError(err);
  if (!server) return { tone: 'error', title };
  const lines = [server.message];
  const raw = (server.details as { conflicts?: unknown } | undefined)?.conflicts;
  const conflicts = Array.isArray(raw)
    ? raw.filter((path): path is string => typeof path === 'string' && !server.message.includes(path))
    : [];
  lines.push(...conflicts.slice(0, MAX_FAILURES_SHOWN));
  if (conflicts.length > MAX_FAILURES_SHOWN) lines.push(`외 ${conflicts.length - MAX_FAILURES_SHOWN}건 더`);
  return { tone: 'error', title, message: lines.filter(Boolean).join('\n') || undefined };
}
