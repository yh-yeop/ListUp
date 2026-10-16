import { Alert, Platform } from 'react-native';
import { showToast } from './toast';

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

/**
 * 짧은 안내. 화면 아래에 토스트로 잠시 띄운다(`ToastHost`) — 모달로 흐름을 끊지 않는다.
 * 대답이 필요한 물음은 {@link confirmAction} 을 쓴다.
 */
export function notify(title: string, message?: string): void {
  if (!title && !message) return;
  showToast(title || message!, title ? message : undefined, 'info');
}

/** 끝났다는 안내(올림·복사·저장). */
export function notifySuccess(title: string, message?: string): void {
  showToast(title, message, 'success');
}

/** 일부만 됐거나 건너뛴 것이 있다는 안내. */
export function notifyWarning(title: string, message?: string): void {
  showToast(title, message, 'warning');
}

/** 실패 안내. 조금 더 오래 보인다. */
export function notifyError(title: string, message?: string): void {
  showToast(title, message, 'error');
}
