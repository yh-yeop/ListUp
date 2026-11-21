/**
 * 키보드 단축키(웹·PC 앱) — 어떤 키가 어떤 동작인지. 순수 함수(app/test 가 node 에서 검사한다).
 * 화면은 lib/shortcuts.ts 의 훅으로 keydown 을 받아 여기서 동작을 고른다.
 */

export type ShortcutAction = 'focus-search' | 'folder-up' | 'escape' | 'help' | 'refresh';

export interface Shortcut {
  /** 도움말에 보이는 키. 여러 개면 "또는". */
  keys: string[];
  action: ShortcutAction;
  description: string;
}

/** 도움말 화면이 그대로 보인다. 순서 = 보이는 순서. */
export const SHORTCUTS: Shortcut[] = [
  { keys: ['/'], action: 'focus-search', description: '파일 찾기 칸으로 (저장소 파일 화면)' },
  { keys: ['Backspace', 'Alt+↑'], action: 'folder-up', description: '위 폴더로' },
  { keys: ['Esc'], action: 'escape', description: '찾기 지우기 · 펼친 메뉴·이름 바꾸기 닫기' },
  { keys: ['R'], action: 'refresh', description: '목록 새로고침' },
  { keys: ['?'], action: 'help', description: '사용법·단축키 보기' },
];

export interface KeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** 글을 쓰는 칸(input·textarea·contenteditable)에서 눌렀다. */
  editing?: boolean;
}

/**
 * 눌린 키 → 동작. 글을 쓰는 중에는 Esc 만 받는다(찾기 칸에서 Esc 로 지우기). Ctrl·⌘ 이 섞이면 브라우저·OS
 * 단축키(복사·새로고침 …)라 건드리지 않는다.
 */
export function matchShortcut(input: KeyInput): ShortcutAction | null {
  if (input.ctrlKey || input.metaKey) return null;
  if (input.key === 'Escape') return 'escape';
  if (input.editing) return null;
  if (input.altKey) return input.key === 'ArrowUp' ? 'folder-up' : null;
  switch (input.key) {
    case '/':
      return 'focus-search';
    case 'Backspace':
      return 'folder-up';
    case '?':
      return 'help';
    case 'r':
    case 'R':
      return 'refresh';
    default:
      return null;
  }
}

/** 위 폴더 경로. 맨 위면 null(더 올라갈 곳이 없다). */
export function parentPath(path: string): string | null {
  if (!path) return null;
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}
