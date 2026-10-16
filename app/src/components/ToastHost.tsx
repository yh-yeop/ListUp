import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { AccessibilityInfo, Animated, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dismissToast, subscribeToasts, type Toast, type ToastTone } from '../lib/toast';
import { CONTENT_MAX_WIDTH, radius, spacing, useTheme, type Palette } from '../theme';
import { Body, Caption } from './ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

const ICON: Record<ToastTone, IconName> = {
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'warning',
  error: 'alert-circle',
};

function toneColor(colors: Palette, tone: ToastTone): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'error':
      return colors.danger;
    default:
      return colors.accent;
  }
}

/**
 * 루트에 한 번 두는 토스트 자리. 화면 아래쪽에 겹쳐 그리고, 토스트가 없는 곳은 터치를 그대로 아래로 넘긴다.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: insets.bottom + spacing.lg,
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        gap: spacing.sm,
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </View>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;
  const color = toneColor(colors, toast.tone);
  const text = toast.message ? `${toast.title}\n${toast.message}` : toast.title;

  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: Platform.OS !== 'web' }).start();
    // iOS 는 accessibilityLiveRegion 이 없으므로 직접 읽어 준다.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    const timer = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [opacity, toast.id, toast.durationMs, text]);

  return (
    <Animated.View style={{ opacity, width: '100%', maxWidth: Math.min(CONTENT_MAX_WIDTH, 560) }}>
      <Pressable
        onPress={() => dismissToast(toast.id)}
        accessibilityRole={toast.tone === 'error' ? 'alert' : 'text'}
        accessibilityLiveRegion={toast.tone === 'error' ? 'assertive' : 'polite'}
        accessibilityHint="눌러서 닫기"
        aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        testID="toast"
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          borderLeftWidth: 4,
          borderLeftColor: color,
          backgroundColor: colors.surface,
          shadowColor: '#000',
          shadowOpacity: 0.15,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }}
      >
        <Ionicons name={ICON[toast.tone]} size={20} color={color} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Body style={{ fontWeight: '600' }}>{toast.title}</Body>
          {toast.message ? <Caption>{toast.message}</Caption> : null}
        </View>
        <Ionicons name="close" size={16} color={colors.textFaint} style={{ marginTop: 2 }} />
      </Pressable>
    </Animated.View>
  );
}
