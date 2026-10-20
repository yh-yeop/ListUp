import { ApiError, api } from '../api/client';

/**
 * 되돌리기 — 이력에 있던 내용(blobHash)으로 그 경로를 다시 반영한다. 파일을 다시 올리지 않는다.
 * 서버는 이 저장소 이력에 있던 내용이면 커밋·제안에 받아 준다.
 * - 편집자: 커밋 하나로 바로 반영
 * - 열람자: 같은 내용으로 변경 제안을 만든다(편집자가 확인한 뒤 반영)
 */
export async function restoreFiles(
  repoId: string,
  changes: { path: string; blobHash: string }[],
  { isEditor, message }: { isEditor: boolean; message: string },
): Promise<{ kind: 'commit' } | { kind: 'proposal'; proposalId: string }> {
  if (isEditor) {
    await api.commitFiles(repoId, changes, message);
    return { kind: 'commit' };
  }
  const { proposal } = await api.createProposal(repoId, {
    title: message,
    description: '변경 이력에 있던 내용으로 되돌립니다.',
    changes,
  });
  return { kind: 'proposal', proposalId: proposal.id };
}

/** 이 기능이 없는 옛 서버(1.4 까지)인지 — 없는 경로는 404 다. 저장소 화면 안이라 저장소는 있다. */
export function isMissingFeature(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export const MISSING_FEATURE_MESSAGE =
  '이 서버에는 아직 이 기능이 없습니다. 서버 주인에게 ListUp 서버를 1.5 이상으로 업데이트해 달라고 부탁하세요.';
