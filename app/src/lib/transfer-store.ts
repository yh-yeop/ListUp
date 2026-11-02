import { useMemo, useSyncExternalStore } from 'react';
import { onApiTargetChange } from '../api/client';
import { confirmAction, notify } from './dialogs';
import type { TransferPhase } from './pure/transfer-report';
import { abandonTransfer, type UploadProgress } from './transfer';

/**
 * 진행 중인 전송(올리기·받기) — 진행률과 멈추는 수단을 화면 밖에 둔다(toast.ts 와 같은 모양).
 * 화면은 runTransfer 로 일을 맡기고 결과만 기다린다. 루트 레이아웃의 TransferHost 가 진행 카드를 그린다.
 *
 * 화면 안에 두면 올리는 중에 다른 탭으로 갔다 오는 순간 진행률·멈추기가 사라지고, 같은 파일을 또 올릴 수
 * 있었다(U2-1). 여기 두면 화면이 바뀌어도 카드가 남고, 같은 저장소에 두 번째 올리기를 막을 수 있다.
 */

export type TransferKind = 'upload' | 'download';

/** 카드에 보일 진행 정보. phase 가 없으면 보내는 중이다. */
export type TransferJobProgress = UploadProgress & { phase?: TransferPhase };

export interface TransferJob {
  id: number;
  kind: TransferKind;
  repoId: string;
  /** 보내는 중일 때 카드 제목 — 올리는 중·담는 중·받는 중. progressbar 이름의 앞부분이다(e2e 가 찾는다). */
  label: string;
  /** 멈출지 물을 때 무엇이 남고 무엇이 사라지는지 알려 주는 문구 */
  cancelMessage: string;
  /**
   * 누가 이 전송의 수명을 쥐는지. store 는 화면이 사라져도 끝까지 간다. screen 은 그 화면이 사라질 때
   * 확인 없이 멈춘다 — 화면이 이미 「버릴까요?」를 물었다(new-proposal 의 beforeRemove).
   */
  owner: 'store' | 'screen';
  progress: TransferJobProgress;
  /** 멈추라고 했고 아직 끝나지 않았다 */
  cancelling: boolean;
}

/** 같은 저장소에 이미 올리는 중이라 시작하지 않았다. 스토어가 토스트를 띄웠으니 부른 쪽은 조용히 돌아가면 된다. */
export class TransferBusy extends Error {
  constructor() {
    super('이미 올리는 중입니다.');
    this.name = 'TransferBusy';
  }
}

export interface TransferHandle<T> {
  id: number;
  /** 일이 끝나면(멈춰도) 일의 결과로 풀린다. 일이 던지면 그대로 던진다. */
  promise: Promise<T>;
  /** 확인 없이 멈춘다 — owner 'screen' 의 화면이 사라질 때. */
  abort(): void;
  /** task 에 넘긴 signal — 끝난 뒤 isAbandoned(signal) 로 서버 전환·로그아웃 때문인지 본다. */
  signal: AbortSignal;
}

interface State {
  /** 시작한 차례대로 */
  jobs: TransferJob[];
  /** 저장소마다 끝난 올리기 수 — 바뀌면 그 저장소 화면이 목록을 다시 읽는다. */
  finished: Readonly<Record<string, number>>;
}

let state: State = { jobs: [], finished: {} };
let nextId = 1;
const controllers = new Map<number, AbortController>();
const listeners = new Set<() => void>();

function setState(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function patchJob(id: number, patch: Partial<TransferJob>) {
  if (!state.jobs.some((job) => job.id === id)) return;
  setState({ ...state, jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)) });
}

/**
 * 전송을 맡긴다. task 는 report 로 진행을 알리고 signal 이 끊기면 멈춘다(lib/transfer.ts 의 함수들이 그 모양).
 * 같은 저장소에 올리기가 이미 있으면 토스트를 띄우고 TransferBusy 를 던진다 — 저장소당 올리기는 하나.
 */
export function runTransfer<T>(input: {
  kind: TransferKind;
  repoId: string;
  label: string;
  cancelMessage: string;
  owner?: 'store' | 'screen';
  /** 첫 진행 보고 전에 카드에 보일 파일 수 */
  totalFiles?: number;
  task: (report: (progress: TransferJobProgress) => void, signal: AbortSignal) => Promise<T>;
}): TransferHandle<T> {
  const { kind, repoId, task } = input;
  if (kind === 'upload' && state.jobs.some((job) => job.kind === 'upload' && job.repoId === repoId)) {
    notify('이미 올리는 중입니다.', '지금 올리는 것이 끝난 뒤에 다시 해 주세요.');
    throw new TransferBusy();
  }
  const id = nextId++;
  const controller = new AbortController();
  controllers.set(id, controller);
  const job: TransferJob = {
    id,
    kind,
    repoId,
    label: input.label,
    cancelMessage: input.cancelMessage,
    owner: input.owner ?? 'store',
    progress: { sentBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: input.totalFiles ?? 0, current: '' },
    cancelling: false,
  };
  setState({ ...state, jobs: [...state.jobs, job] });

  const report = (progress: TransferJobProgress) => patchJob(id, { progress });
  const promise = (async () => {
    try {
      return await task(report, controller.signal);
    } finally {
      controllers.delete(id);
      const finished = kind === 'upload' ? { ...state.finished, [repoId]: (state.finished[repoId] ?? 0) + 1 } : state.finished;
      setState({ jobs: state.jobs.filter((other) => other.id !== id), finished });
    }
  })();
  return { id, promise, abort: () => abortTransfer(id), signal: controller.signal };
}

/** 확인 없이 멈춘다. */
function abortTransfer(id: number) {
  const controller = controllers.get(id);
  if (!controller || controller.signal.aborted) return;
  patchJob(id, { cancelling: true });
  controller.abort();
}

/** 멈출지 물은 뒤 멈춘다 — 진행 카드의 「멈추기」. */
export async function cancelTransfer(id: number): Promise<void> {
  const job = state.jobs.find((other) => other.id === id);
  const controller = controllers.get(id);
  if (!job || !controller || controller.signal.aborted) return;
  const ok = await confirmAction({ title: '멈출까요?', message: job.cancelMessage, confirmLabel: '멈추기', destructive: true });
  // 묻는 사이에 끝났으면 아무것도 하지 않는다.
  if (!ok || controllers.get(id) !== controller) return;
  abortTransfer(id);
}

/**
 * 전송을 모두 그만둔다 — 서버가 바뀌었거나 로그아웃했을 때. 멈춤과 달리 올린 파일을 반영하지 않는다
 * (transfer.ts abandonTransfer). 화면은 그 서버의 이야기라 따로 알리지 않고 여기서 한 번만 알린다.
 */
export function abortAllTransfers(): void {
  const running = [...controllers.entries()].filter(([, controller]) => !controller.signal.aborted);
  if (running.length === 0) return;
  for (const [id, controller] of running) {
    patchJob(id, { cancelling: true });
    abandonTransfer(controller);
  }
  notify('진행 중이던 전송을 멈췄습니다.', '서버를 바꾸거나 로그아웃하면 올리기·받기를 이어 가지 않습니다.');
}

// 서버가 바뀌거나 토큰이 사라지면(로그아웃·세션 끊김) 옛 서버의 전송을 이어 가지 않는다.
onApiTargetChange(({ serverChanged, token }) => {
  if (serverChanged || token === null) abortAllTransfers();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;

/**
 * 전송 상태를 지켜본다. repoId 를 주면 그 저장소의 것만.
 * - jobs: 진행 중인 전송(시작한 차례대로)
 * - active: 그 저장소에 진행 중인 올리기(없으면 null) — 올리기 버튼을 막는 데 쓴다
 * - finishedSeq: 그 저장소에서 끝난 올리기 수 — 바뀌면 목록을 다시 읽는다
 */
export function useTransfers(repoId?: string): {
  jobs: TransferJob[];
  active: TransferJob | null;
  finishedSeq: number;
} {
  const current = useSyncExternalStore(subscribe, getState, getState);
  return useMemo(() => {
    const jobs = repoId === undefined ? current.jobs : current.jobs.filter((job) => job.repoId === repoId);
    return {
      jobs,
      active: repoId === undefined ? null : (jobs.find((job) => job.kind === 'upload') ?? null),
      finishedSeq: repoId === undefined ? 0 : (current.finished[repoId] ?? 0),
    };
  }, [current, repoId]);
}
