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
