import { router } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { isConnectionProblem } from './connection-error';
import { showToast, type ToastAction, type ToastTone } from './toast';

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
 * 짧은 안내 — 화면 아래 토스트로 띄운다(components/Toast.tsx). 모달이 아니라 흐름을 끊지 않고,
 * 화면을 옮겨도 남는다. 사용자가 골라야 하는 것은 confirmAction 으로.
 */
export function notify(title: string, message?: string, tone: ToastTone = 'info'): void {
  if (!title && !message) return;
  showToast({ title: title || message!, message: title ? message : undefined, tone });
}

/**
 * 버튼이 달린 안내 — 지우기·옮기기 뒤 「되돌리기」처럼, 확인 대화상자 대신 해 놓고 바로 무를 길을 준다.
 * 보통 안내보다 오래(10초 이상) 남는다.
 */
export function notifyWithAction(title: string, message: string | undefined, action: ToastAction): void {
  showToast({ title, message, tone: 'info', action });
}

/** 해낸 일 안내 (저장했습니다, 복사했습니다 …). */
export function notifySuccess(title: string, message?: string): void {
  notify(title, message, 'success');
}

/**
 * 실패 안내 — 더 오래 남고 스크린리더가 바로 읽는다. 서버에 닿지 못한 실패(client.ts 의 연결 오류 문장)면
 * ErrorNotice 처럼 「연결 문제 해결」 버튼을 단다 — 받기·올리기·지우기 실패는 토스트로만 알려 갈 곳이 없었다.
 */
export function notifyError(title: string, message?: string): void {
  if (isConnectionProblem(title) || (message !== undefined && isConnectionProblem(message))) {
    showToast({
      title: title || message!,
      message: title ? message : undefined,
      tone: 'error',
      action: { label: '연결 문제 해결', onPress: () => router.push('/troubleshoot') },
    });
    return;
  }
  notify(title, message, 'error');
}
