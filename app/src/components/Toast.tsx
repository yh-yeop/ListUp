import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { AccessibilityInfo, Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dismissToast, subscribeToasts, type Toast, type ToastTone } from '../lib/toast';
import { fontSize, radius, spacing, useTheme, type Palette } from '../theme';

const ICON: Record<ToastTone, ComponentProps<typeof Ionicons>['name']> = {
  info: 'information-circle',
  success: 'checkmark-circle',
  error: 'alert-circle',
};

function toneColors(tone: ToastTone, colors: Palette): { bg: string; border: string; icon: string } {
  switch (tone) {
    case 'success':
      return { bg: colors.surface, border: colors.success, icon: colors.success };
    case 'error':
      return { bg: colors.dangerSoft, border: colors.danger, icon: colors.danger };
    default:
      return { bg: colors.surface, border: colors.border, icon: colors.accent };
  }
}

/**
 * 화면 아래쪽에 쌓이는 토스트. 루트 레이아웃에 하나만 둔다.
 * 누르면 닫히고, 그대로 두면 잠시 뒤 사라진다(lib/toast.ts).
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const insets = useSafeAreaInsets();
  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        // 웹은 화면을 스크롤해도 창 아래에 붙어 있게.
        Platform.OS === 'web' ? ({ position: 'fixed' } as unknown as object) : null,
        { bottom: insets.bottom + spacing.lg },
      ]}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </View>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const { colors } = useTheme();
  const tone = toneColors(toast.tone, colors);
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
    // iOS 는 liveRegion 이 없어 직접 읽어 준다.
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(toast.message ? `${toast.title}. ${toast.message}` : toast.title);
    }
  }, [appear, toast]);

  const live = toast.tone === 'error' ? 'assertive' : 'polite';
  return (
    <Animated.View
      style={{
        width: '100%',
        maxWidth: 480,
        opacity: appear,
        transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }}
    >
      <Pressable
        onPress={() => dismissToast(toast.id)}
        accessibilityRole={toast.tone === 'error' ? 'alert' : undefined}
        accessibilityLiveRegion={live}
        accessibilityHint="눌러서 닫기"
        // 웹 스크린리더용 — RN-web 은 role/aria-live 를 그대로 넘긴다.
        role={toast.tone === 'error' ? 'alert' : 'status'}
        aria-live={live}
        style={({ pressed }) => [
          styles.toast,
          { backgroundColor: tone.bg, borderColor: tone.border, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Ionicons name={ICON[toast.tone]} size={20} color={tone.icon} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '600', lineHeight: 21 }}>
            {toast.title}
          </Text>
          {toast.message ? (
            <Text style={{ color: colors.textMuted, fontSize: fontSize.sm, lineHeight: 19 }}>{toast.message}</Text>
          ) : null}
        </View>
        <Ionicons name="close" size={16} color={colors.textFaint} style={{ marginTop: 2 }} aria-hidden />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    zIndex: 1000,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
