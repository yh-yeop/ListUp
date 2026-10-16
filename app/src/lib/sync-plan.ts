/**
 * 폴더 동기화 계획 — 마지막으로 맞춘 상태(기준), 내 폴더, 저장소 셋을 경로마다 견줘 할 일을 정한다(3-way).
 * 둘만 견주면 "내가 지웠다"와 "저쪽이 새로 만들었다"를 가릴 수 없지만, 기준이 있으면 누가 바꿨는지 안다.
 *
 *   내 쪽만 바뀜   → 올리기(편집자는 반영, 열람자는 변경 제안) / 내가 지움 → 저장소에서 지우기
 *   저장소만 바뀜  → 받기 / 저장소에서 지워짐 → 내 폴더에서 지우기(휴지통)
 *   둘 다 바뀜     → 같은 내용이면 그냥 맞춤, 다르면 충돌 — 사람이 고른다
 *
 * 순수 함수다. 파일을 읽거나 쓰지 않는다 — 화면(app/repo/[repoId]/sync.tsx)이 계획을 보여 주고 실행한다.
 */

/** 열람자가 지우기를 제안해 둔 표시 (proposedHash). */
export const PROPOSED_DELETE = '-';

/**
 * 기준에 남기는 한 파일. 마지막으로 맞췄을 때 양쪽이 이 내용이었다. hash 가 '' 이면 마지막으로 맞췄을 때 없던
 * 파일이다(열람자가 새 파일을 제안해 두었을 때 그 표시만 남긴다).
 */
export interface SyncBaseEntry {
  hash: string;
  size: number;
  /** 내 폴더 파일의 고친 시각 — 크기와 함께 같으면 다시 읽지 않고 그대로라고 본다. */
  mtime?: number;
  /**
   * 열람자가 이 내용을 변경 제안으로 보냈다(아직 반영 전) — 같은 내용을 또 제안하지 않는다. 지우기를 제안했으면
   * {@link PROPOSED_DELETE}.
   */
  proposedHash?: string;
  /** 그 제안. 닫혔으면 표시를 지워 다시 보낼 수 있게 한다. */
  proposedId?: string;
}

export type SyncBase = Record<string, SyncBaseEntry>;

export interface LocalSide {
  /** 내용 해시. 모르면(계산할 필요가 없던 새 파일) null — 어차피 올리거나 충돌이다. */
  hash: string | null;
  size: number;
  mtime?: number;
}

export interface RemoteSide {
  hash: string;
  size: number;
}

export type ConflictReason =
  /** 둘 다 내용을 바꿨다 */
  | 'both-changed'
  /** 내 쪽은 바꿨는데 저장소에서는 지워졌다 */
  | 'changed-deleted'
  /** 내 쪽은 지웠는데 저장소에서는 바뀌었다 */
  | 'deleted-changed'
  /** 처음 맞추는데(기준 없음) 양쪽 내용이 다르다 */
  | 'first-differs';

export type SyncAction =
  | { kind: 'upload'; path: string }
  | { kind: 'download'; path: string }
  | { kind: 'delete-remote'; path: string }
  | { kind: 'delete-local'; path: string }
  | { kind: 'conflict'; path: string; reason: ConflictReason }
  /** 열람자가 이미 제안해 둔 내용 — 반영을 기다린다. */
  | { kind: 'proposed'; path: string }
  /** 내 폴더에서 옮기거나 이름을 바꿨다 — 저장소에서도 옮긴다(다시 올리지 않는다). */
  | { kind: 'move-remote'; path: string; from: string }
  /** 저장소에서 옮기거나 이름이 바뀌었다 — 내 폴더에서도 옮긴다(다시 받지 않는다). */
  | { kind: 'move-local'; path: string; from: string };

export interface SyncPlan {
  actions: SyncAction[];
  /** 할 일 없이 기준만 고치면 되는 것(양쪽이 같은 내용이 됨, 양쪽 다 지워짐). */
  adopt: { path: string; entry: SyncBaseEntry | null }[];
}

const sameHash = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a === b;

/**
 * 계획을 세운다. base 가 null 이면 처음 맞추는 것이다 — 한쪽에만 있는 것은 그쪽으로 채우고, 양쪽에 있는데
 * 다르면 충돌로 둔다(처음부터 무엇이 옳은지 알 수 없으니 지우지는 않는다).
 */
export function planSync(base: SyncBase | null, local: Map<string, LocalSide>, remote: Map<string, RemoteSide>): SyncPlan {
  const plan: SyncPlan = { actions: [], adopt: [] };
  const paths = new Set<string>([...Object.keys(base ?? {}), ...local.keys(), ...remote.keys()]);

  for (const path of [...paths].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }))) {
    const b = base?.[path];
    const l = local.get(path);
    const r = remote.get(path);

    // 양쪽이 같은 내용이면 할 일이 없다 — 기준만 맞춘다.
    if (l && r && sameHash(l.hash, r.hash)) {
      if (!b || b.hash !== r.hash || b.mtime !== l.mtime || b.proposedHash) {
        plan.adopt.push({ path, entry: { hash: r.hash, size: r.size, mtime: l.mtime } });
      }
      continue;
    }
    if (!l && !r) {
      if (b) plan.adopt.push({ path, entry: null });
      continue;
    }

    if (!base) {
      if (l && !r) plan.actions.push({ kind: 'upload', path });
      else if (!l && r) plan.actions.push({ kind: 'download', path });
      else plan.actions.push({ kind: 'conflict', path, reason: 'first-differs' });
      continue;
    }

    // 있음·없음까지 견준다 — 기준에 없던(또는 '' 인) 파일이 지금도 없으면 "그대로"다.
    const baseHash = b?.hash || null;
    const localSame = l ? l.hash !== null && l.hash === baseHash : baseHash === null;
    const remoteSame = r ? r.hash === baseHash : baseHash === null;

    if (localSame && remoteSame) continue;
    if (localSame) {
      // 내 쪽은 그대로 — 저장소를 따른다.
      plan.actions.push(r ? { kind: 'download', path } : { kind: 'delete-local', path });
      continue;
    }
    if (remoteSame) {
      // 저장소는 그대로 — 내 쪽을 따른다. 이미 제안해 둔 것이면 반영을 기다린다.
      const proposed = b?.proposedHash;
      if (proposed && (l ? sameHash(l.hash, proposed) : proposed === PROPOSED_DELETE)) {
        plan.actions.push({ kind: 'proposed', path });
      } else {
        plan.actions.push(l ? { kind: 'upload', path } : { kind: 'delete-remote', path });
      }
      continue;
    }
    // 둘 다 바뀜.
    const reason: ConflictReason = l && r ? 'both-changed' : l ? 'changed-deleted' : 'deleted-changed';
    plan.actions.push({ kind: 'conflict', path, reason });
  }
  plan.actions = pairMoves(plan.actions, base, local, remote);
  return plan;
}

/**
 * "지우기 + 같은 내용 올리기"는 옮긴 것이다. 내 쪽에서 지운 경로(기준의 해시)와 내 쪽의 새 파일(같은 해시)을 짝지어
 * move-remote 로, 저장소 쪽도 같은 방식으로 move-local 로 바꾼다. 한 파일은 한 번만 짝짓는다.
 */
function pairMoves(actions: SyncAction[], base: SyncBase | null, local: Map<string, LocalSide>, remote: Map<string, RemoteSide>): SyncAction[] {
  if (!base) return actions;
  const result: SyncAction[] = [];
  const consumed = new Set<number>();
  const pair = (
    deleteKind: 'delete-remote' | 'delete-local',
    addKind: 'upload' | 'download',
    moveKind: 'move-remote' | 'move-local',
    hashOfAdded: (path: string) => string | null | undefined,
  ) => {
    const deletedByHash = new Map<string, number[]>();
    actions.forEach((action, index) => {
      if (action.kind !== deleteKind) return;
      const hash = base[action.path]?.hash;
      if (hash) deletedByHash.set(hash, [...(deletedByHash.get(hash) ?? []), index]);
    });
    actions.forEach((action, index) => {
      if (action.kind !== addKind) return;
      const hash = hashOfAdded(action.path);
      const candidates = hash ? deletedByHash.get(hash) : undefined;
      const from = candidates?.find((i) => !consumed.has(i));
      if (from === undefined) return;
      consumed.add(from);
      consumed.add(index);
      result.push({ kind: moveKind, path: action.path, from: actions[from].path });
    });
  };
  pair('delete-remote', 'upload', 'move-remote', (path) => local.get(path)?.hash);
  pair('delete-local', 'download', 'move-local', (path) => remote.get(path)?.hash);
  return [...actions.filter((_, index) => !consumed.has(index)), ...result];
}

/** 충돌 하나를 어떻게 풀지 — 내 쪽을 따르면 올리기/저장소에서 지우기, 저장소를 따르면 받기/내 폴더에서 지우기. */
export function resolveConflict(
  conflict: Extract<SyncAction, { kind: 'conflict' }>,
  choice: 'mine' | 'theirs',
  sides: { local: boolean; remote: boolean },
): SyncAction {
  if (choice === 'mine') return sides.local ? { kind: 'upload', path: conflict.path } : { kind: 'delete-remote', path: conflict.path };
  return sides.remote ? { kind: 'download', path: conflict.path } : { kind: 'delete-local', path: conflict.path };
}

/**
 * 해시를 새로 계산해야 하는 내 파일인지. 기준과 크기·고친 시각이 같으면 그대로라고 보고 읽지 않는다. 기준에 없고
 * 저장소에 같은 경로·같은 크기가 없으면 어차피 올리거나 충돌이라 내용을 몰라도 된다(올릴 때 계산한다).
 */
export function needsHash(
  path: string,
  local: { size: number; mtime?: number },
  base: SyncBase | null,
  remote: Map<string, RemoteSide>,
  /** 기준에 있는데 지금 내 폴더에 없는 파일들의 크기 — 새 파일이 그중 하나와 크기가 같으면 옮긴 것일 수 있다. */
  missingSizes: Set<number> = new Set(),
): boolean {
  const b = base?.[path];
  if (b && b.size === local.size && b.mtime !== undefined && b.mtime === local.mtime) return false;
  if (b) return true;
  const r = remote.get(path);
  return (!!r && r.size === local.size) || missingSizes.has(local.size);
}

/** 기준에서 그대로라고 본 내 파일의 해시. 열람자가 제안해 둔 새 파일은 그 제안한 해시다. */
export function cachedHash(path: string, local: { size: number; mtime?: number }, base: SyncBase | null): string | null {
  const b = base?.[path];
  if (!b || b.size !== local.size || b.mtime === undefined || b.mtime !== local.mtime) return null;
  return b.hash || (b.proposedHash && b.proposedHash !== PROPOSED_DELETE ? b.proposedHash : null);
}

/** 자동으로 해도 되는 계획인지 — 지우기와 충돌이 없을 때만. 지우는 것은 늘 사람이 확인한다. */
export function isSafeToAutoApply(plan: SyncPlan): boolean {
  return plan.actions.every(
    (action) => action.kind === 'upload' || action.kind === 'download' || action.kind === 'proposed' || action.kind === 'move-remote' || action.kind === 'move-local',
  );
}
