import { Alert, Platform } from 'react-native';

/**
 * 확인 대화상자. react-native-web 의 Alert 는 버튼을 지원하지 않으므로
 * 웹에서는 브라우저 confirm 을 쓴다.
 */
export function confirmAction(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const { title, message, confirmLabel = '확인', destructive } = options;

  if (Platform.OS === 'web') {
    const text = message ? `${title}\n\n${message}` : title;
    return Promise.resolve(
      typeof globalThis.confirm === 'function' ? globalThis.confirm(text) : true,
    );
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: '취소', style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

/** 짧은 안내. 웹에서는 alert, 네이티브에서는 Alert. */
export function notify(title: string, message?: string): void {
  if (!title && !message) return;
  if (Platform.OS === 'web') {
    const text = message ? `${title}\n\n${message}` : title;
    if (typeof globalThis.alert === 'function') globalThis.alert(text);
    return;
  }
  Alert.alert(title, message);
}

/** 한 줄 입력을 받는다. 웹은 prompt, 네이티브는 Alert.prompt(iOS)/폴백. */
export function promptText(options: {
  title: string;
  message?: string;
  defaultValue?: string;
}): Promise<string | null> {
  const { title, message, defaultValue = '' } = options;

  if (Platform.OS === 'web') {
    const text = message ? `${title}\n${message}` : title;
    const value =
      typeof globalThis.prompt === 'function' ? globalThis.prompt(text, defaultValue) : null;
    return Promise.resolve(value);
  }

  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      Alert.prompt(
        title,
        message,
        [
          { text: '취소', style: 'cancel', onPress: () => resolve(null) },
          { text: '확인', onPress: (value?: string) => resolve(value ?? null) },
        ],
        'plain-text',
        defaultValue,
      );
    });
  }

  // Android 에는 시스템 입력 대화상자가 없다 — 호출부에서 화면 안 입력으로 처리한다.
  return Promise.resolve(null);
}

/** Android 에서 promptText 를 쓸 수 없으므로, 화면 내 입력이 필요한지 알려준다. */
export const NEEDS_INLINE_PROMPT = Platform.OS === 'android';
