import { Ionicons } from '@expo/vector-icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CONTENT_MAX_WIDTH, fontSize, radius, spacing, useTheme } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

// ---------------------------------------------------------------------------
// 화면 골격
// ---------------------------------------------------------------------------

export function Screen({
  children,
  refreshControl,
  padded = true,
}: {
  children: ReactNode;
  refreshControl?: ComponentProps<typeof ScrollView>['refreshControl'];
  padded?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={refreshControl}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.contentWrap, padded && { padding: spacing.lg }]}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          overflow: 'hidden',
        },
        padded && { padding: spacing.lg },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// 글자
// ---------------------------------------------------------------------------

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  return (
    <Text style={[{ color: colors.text, fontSize: fontSize.xl, fontWeight: '700' }, style]}>
      {children}
    </Text>
  );
}

export function Subtitle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  return (
    <Text style={[{ color: colors.textMuted, fontSize: fontSize.md, lineHeight: 22 }, style]}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
  numberOfLines,
  style,
}: {
  children: ReactNode;
  muted?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ color: muted ? colors.textMuted : colors.text, fontSize: fontSize.md }, style]}
    >
      {children}
    </Text>
  );
}

export function Caption({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ color: colors.textFaint, fontSize: fontSize.xs }, style]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// 버튼
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  full,
  compact,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const isDisabled = disabled || loading;

  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.accent, fg: colors.accentText, border: colors.accent },
    secondary: { bg: colors.surfaceAlt, fg: colors.text, border: colors.border },
    ghost: { bg: 'transparent', fg: colors.textMuted, border: 'transparent' },
    danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
  };
  const tone = palette[variant];

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={({ pressed }) => [
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.md,
          paddingVertical: compact ? spacing.sm : spacing.md,
          paddingHorizontal: compact ? spacing.md : spacing.lg,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.sm,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tone.fg} />
      ) : icon ? (
        <Ionicons name={icon} size={compact ? 15 : 17} color={tone.fg} />
      ) : null}
      <Text style={{ color: tone.fg, fontSize: compact ? fontSize.sm : fontSize.md, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 목록 항목 등에서 쓰는 아이콘 전용 버튼. */
export function IconButton({
  icon,
  onPress,
  label,
  tone,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  tone?: 'default' | 'danger';
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        padding: spacing.sm,
        borderRadius: radius.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={20} color={tone === 'danger' ? colors.danger : colors.textMuted} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// 입력
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' }}>
        {label}
      </Text>
      {children}
      {hint ? <Caption>{hint}</Caption> : null}
    </View>
  );
}

const INPUT_FOCUS_BORDER = 2;

export function Input(props: ComponentProps<typeof TextInput>) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  // 포커스 때 테두리가 두꺼워져도 안쪽 글자가 움직이지 않게 여백으로 상쇄한다.
  const borderWidth = focused ? INPUT_FOCUS_BORDER : StyleSheet.hairlineWidth;
  const padding = spacing.md + INPUT_FOCUS_BORDER - borderWidth;

  return (
    <TextInput
      placeholderTextColor={colors.textFaint}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: focused ? colors.accent : colors.border,
          borderWidth,
          borderRadius: radius.md,
          paddingHorizontal: padding,
          paddingVertical: padding,
          color: colors.text,
          fontSize: fontSize.md,
          // 웹의 기본 파란 아웃라인은 끄고, 위의 accent 테두리로 포커스를 표시한다.
          ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
        } as ViewStyle,
        props.style,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// 상태 표시
// ---------------------------------------------------------------------------

export function Badge({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
  icon?: IconName;
}) {
  const { colors } = useTheme();
  const tones = {
    neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
    accent: { bg: colors.accentSoft, fg: colors.accent },
    success: { bg: colors.successSoft, fg: colors.success },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    warning: { bg: colors.warningSoft, fg: colors.warning },
  };
  const picked = tones[tone];

  return (
    <View
      style={{
        backgroundColor: picked.bg,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.sm + 2,
        paddingVertical: 3,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
      }}
    >
      {icon ? <Ionicons name={icon} size={12} color={picked.fg} /> : null}
      <Text style={{ color: picked.fg, fontSize: fontSize.xs, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.md }}>
      <ActivityIndicator color={colors.accent} />
      <Caption>{label}</Caption>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          backgroundColor: colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: spacing.xs,
        }}
      >
        <Ionicons name={icon} size={26} color={colors.textFaint} />
      </View>
      <Text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '600' }}>{title}</Text>
      {description ? (
        <Text
          style={{
            color: colors.textMuted,
            fontSize: fontSize.sm,
            textAlign: 'center',
            maxWidth: 340,
            lineHeight: 20,
          }}
        >
          {description}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.dangerSoft,
        borderRadius: radius.md,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
        <Ionicons name="alert-circle" size={18} color={colors.danger} style={{ marginTop: 1 }} />
        <Text style={{ color: colors.danger, fontSize: fontSize.sm, flex: 1, lineHeight: 20 }}>
          {message}
        </Text>
      </View>
      {onRetry ? <Button label="다시 시도" variant="ghost" compact onPress={onRetry} /> : null}
    </View>
  );
}

/** 목록 사이 구분선. */
export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

/** 좌우로 벌려 놓는 행. */
export function Row({
  children,
  gap = spacing.sm,
  style,
  wrap,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  wrap?: boolean;
}) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
  },
  contentWrap: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    gap: spacing.lg,
    flex: 1,
  },
});
