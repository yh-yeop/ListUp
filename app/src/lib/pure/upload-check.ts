import { MAX_FILES_PER_REPO, formatBytes, normalizePath } from '@listup/shared';
import { MAX_FAILURES_SHOWN, type Notice } from './transfer-report';

/**
 * 올리기 전 검사 — 서버가 커밋(또는 제안 만들기)에서 거절할 것을 바이트를 보내기 전에 본다. 플랫폼 import 가 없는
 * 순수 함수(app/test 가 node 에서 바로 불러 검사한다). 규칙은 서버와 같다 —
 * - 이름 겹침: services/snapshots.ts `findPathConflict`. 파일과 폴더는 같은 이름을 쓸 수 없다. 커밋은 새 파일을
 *   목록에 넣은 **뒤** 새 경로마다 보므로(routes/files.ts) 새 항목끼리 겹치는 것도 걸린다. 덮어쓰기는 겹침이 아니다.
 * - 파일 수: 커밋 뒤 목록의 파일 수 > MAX_FILES_PER_REPO 면 거절. 덮어쓰기는 수를 늘리지 않는다.
 * - 용량: 커밋 뒤 목록의 크기 합(manifestBytes) > maxRepoBytes 면 거절. 덮어쓰는 파일은 옛 크기를 빼고 새 크기를 더한다.
 * 최종 판정은 어차피 서버가 한다 — 이 검사는 다 올린 뒤에야 막히는 것을 앞당기는 편의다.
 */

/** 올릴 파일 하나 — 저장소 안 경로와 크기. */
export interface PlannedFile {
  path: string;
  size: number;
}

export interface UploadPlanInput {
  items: PlannedFile[];
  /** 저장소 전체 파일(NFC 경로 → 크기). 모르면(전체 목록을 못 받음) null — 이름 겹침 검사만 건너뛴다. */
  existing: ReadonlyMap<string, number> | null;
  /** 지금 저장소의 파일 수·크기 합(저장소 요약의 fileCount·totalSize). */
  fileCount: number;
  totalSize: number;
  maxFiles: number;
  /** 저장소 용량 한도. 모르면(API_LEVEL 6 미만 서버) null — 용량 검사를 건너뛴다. */
  maxRepoBytes: number | null;
}

/** 겹치는 새 경로와 그 상대. against 가 `${path}/` 로 시작하면 path 가 이미 폴더이고, 아니면 상위 경로 against 가 파일이다. */
export interface PathConflict {
  path: string;
  against: string;
}

export interface UploadPlanCheck {
  conflicts: PathConflict[];
  /** 올리면 될 파일 수와 한도. 넘지 않으면 null. */
  tooMany: { count: number; max: number } | null;
  /** 올리면 될 크기 합과 한도. 넘지 않거나 한도를 모르면 null. */
  tooBig: { bytes: number; max: number } | null;
}

/** 서버가 쓰는 경로 모양으로 — 서버는 커밋에서 normalizePath 로 고친 경로를 쓴다. 쓸 수 없는 이름은 NFC 로만. */
const canonical = (path: string) => normalizePath(path) ?? path.normalize('NFC');

export function checkUploadPlan(input: UploadPlanInput): UploadPlanCheck {
  // 같은 경로가 두 번이면 뒤의 것 — 커밋에는 한 번만 들어간다.
  const items = new Map<string, number>();
  for (const item of input.items) items.set(canonical(item.path), item.size);

  let added = 0;
  let bytes = input.totalSize;
  for (const [path, size] of items) {
    const replaced = input.existing?.get(path);
    if (replaced === undefined) added += 1;
    else bytes -= replaced;
    bytes += size;
  }
  const count = input.fileCount + added;
  const tooMany = count > input.maxFiles ? { count, max: input.maxFiles } : null;
  const tooBig =
    input.maxRepoBytes !== null && bytes > input.maxRepoBytes ? { bytes, max: input.maxRepoBytes } : null;

  return { conflicts: input.existing ? findConflicts(input.existing, items) : [], tooMany, tooBig };
}

/**
 * 새 경로(기존에 없던 것)마다 findPathConflict 와 같은 판정을 커밋 뒤 목록(기존 + 새 항목)에 대고 한다.
 * 서버처럼 경로마다 목록 전체를 훑으면 5000×5000 이라, 폴더 이름 → 그 아래 첫 파일을 한 번 모아 둔다.
 */
function findConflicts(existing: ReadonlyMap<string, number>, items: ReadonlyMap<string, number>): PathConflict[] {
  const files = new Set<string>(existing.keys());
  for (const path of items.keys()) files.add(path);
  const folders = new Map<string, string>();
  for (const file of files) {
    for (let idx = file.indexOf('/'); idx !== -1; idx = file.indexOf('/', idx + 1)) {
      const folder = file.slice(0, idx);
      if (!folders.has(folder)) folders.set(folder, file);
    }
  }

  const conflicts: PathConflict[] = [];
  for (const path of items.keys()) {
    if (existing.has(path)) continue; // 덮어쓰기
    const below = folders.get(path);
    if (below !== undefined) {
      conflicts.push({ path, against: below });
      continue;
    }
    for (let idx = path.indexOf('/'); idx !== -1; idx = path.indexOf('/', idx + 1)) {
      const ancestor = path.slice(0, idx);
      if (files.has(ancestor)) {
        conflicts.push({ path, against: ancestor });
        break;
      }
    }
  }
  return conflicts;
}

/** 천 단위 쉼표 — Hermes 의 toLocaleString 은 묶지 않을 수 있어 직접. */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 폴더에서 고른 파일이 한도에서 잘렸을 때 확인창에 덧붙이는 말. */
export const TRUNCATED_NOTE = `파일이 ${formatCount(MAX_FILES_PER_REPO)}개를 넘어 앞의 ${formatCount(MAX_FILES_PER_REPO)}개만 골랐습니다.`;

/** 겹침 한 건을 사람 말로 — `a/b.txt ↔ 파일 a`, `a ↔ 폴더 a`. */
function describeConflict({ path, against }: PathConflict): string {
  return against.startsWith(`${path}/`) ? `${path} ↔ 폴더 ${path}` : `${path} ↔ 파일 ${against}`;
}

/** 검사에 걸렸으면 올리지 않고 띄울 알림, 문제없으면 null. 걸린 것이 여럿이면 제목은 첫 문제, 나머지는 본문에. */
export function describeUploadCheck(check: UploadPlanCheck): Notice | null {
  const problems: { title: string; lines: string[] }[] = [];
  if (check.conflicts.length > 0) {
    const shown = check.conflicts.slice(0, MAX_FAILURES_SHOWN).map(describeConflict);
    const rest = check.conflicts.length - shown.length;
    problems.push({
      title: '이름이 겹쳐 올릴 수 없습니다.',
      lines: [
        '파일과 폴더는 같은 이름을 쓸 수 없습니다.',
        ...shown,
        ...(rest > 0 ? [`외 ${rest}건 더`] : []),
      ],
    });
  }
  if (check.tooMany) {
    problems.push({
      title: '파일이 너무 많아 올릴 수 없습니다.',
      lines: [
        `저장소당 파일은 최대 ${formatCount(check.tooMany.max)}개인데, 올리면 ${formatCount(check.tooMany.count)}개가 됩니다.`,
      ],
    });
  }
  if (check.tooBig) {
    problems.push({
      title: '저장소 용량 한도를 넘어 올릴 수 없습니다.',
      lines: [`한도는 ${formatBytes(check.tooBig.max)}인데, 올리면 ${formatBytes(check.tooBig.bytes)}가 됩니다.`],
    });
  }
  if (problems.length === 0) return null;
  const [first, ...others] = problems;
  const lines = [...first.lines, ...others.flatMap((problem) => [problem.title, ...problem.lines])];
  return { tone: 'error', title: first.title, message: lines.join('\n') };
}
