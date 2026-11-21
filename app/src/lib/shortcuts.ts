import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { matchShortcut, type ShortcutAction } from './pure/shortcuts';

export { SHORTCUTS, parentPath, type ShortcutAction } from './pure/shortcuts';

/** 단축키는 키보드가 있는 웹·PC 앱(웹 빌드)에서만. */
export const shortcutsSupported = Platform.OS === 'web';

function isEditing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/**
 * 화면이 보이는 동안만 단축키를 받는다(스택 아래에 깔린 화면은 받지 않는다). 처리한 동작이면 true 를 돌려주고,
 * 그때만 브라우저 기본 동작(예: Backspace 뒤로 가기, / 빠른 찾기)을 막는다.
 */
export function useKeyboardShortcuts(handler: (action: ShortcutAction) => boolean): void {
  const latest = useRef(handler);
  latest.current = handler;
  useFocusEffect(
    useCallback(() => {
      if (!shortcutsSupported || typeof window === 'undefined') return undefined;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) return;
        const action = matchShortcut({
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          editing: isEditing(event.target),
        });
        if (action && latest.current(action)) event.preventDefault();
      };
      // 캡처 단계로 받는다 — react-native-web 의 TextInput 은 keydown 을 위로 올려 보내지 않아(stopPropagation)
      // 찾기 칸 안의 Esc 가 document 까지 오지 않는다. 칸 안에서는 matchShortcut 이 Esc 만 고른다.
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []),
  );
}
