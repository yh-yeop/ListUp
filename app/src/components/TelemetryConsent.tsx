import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { notifyError } from '../lib/dialogs';
import { setTelemetryConsent, TELEMETRY_ITEMS, TELEMETRY_NOT_RECORDED, useTelemetryConsent } from '../lib/telemetry';
import { fontSize, radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption } from './ui';

/** 수집하는 항목과 이유. */
export function TelemetryItemList() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      {TELEMETRY_ITEMS.map((item) => (
        <View key={item.label} style={{ gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: '600' }}>· {item.label}</Text>
          <Caption style={{ paddingLeft: spacing.md, lineHeight: 18 }}>{item.why}</Caption>
        </View>
      ))}
    </View>
  );
}

/** 기록하지 않는 것. */
export function TelemetryNotRecordedList() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {TELEMETRY_NOT_RECORDED.map((label) => (
        <Text key={label} style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
          · {label}
        </Text>
      ))}
    </View>
  );
}

/**
 * 처음 실행할 때 실행 기록(학교 데이터 분석 과제용)을 모아도 되는지 묻는다. 루트(_layout)에 한 번만 둔다.
 * 저장소에서 설정을 읽기 전(ready=false)에는 띄우지 않는다 — 이미 고른 사람에게 잠깐 보였다 사라지지 않게.
 * 고르지 않고 닫으면(안드로이드 뒤로 가기·웹 Esc) 이번 실행에서만 접고 다음 실행에 다시 묻는다.
 * 거부해도 앱은 그대로 다 쓸 수 있다.
 */
export function TelemetryConsent() {
  const { consent, ready } = useTelemetryConsent();
  const { colors } = useTheme();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<'grant' | 'deny' | null>(null);

  const visible = ready && consent === 'unset' && !dismissed;
  if (!visible) return null;

  const choose = async (granted: boolean) => {
    if (busy) return;
    setBusy(granted ? 'grant' : 'deny');
    try {
      await setTelemetryConsent(granted);
    } catch (err) {
      notifyError('설정을 저장하지 못했습니다.', err instanceof Error ? err.message : undefined);
      // 저장하지 못해도 이번 실행에서는 다시 막지 않는다.
      setDismissed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => setDismissed(true)}
      aria-label="실행 기록 동의"
      accessibilityViewIsModal
    >
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
            <Text role="heading" style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '700' }}>
              실행 기록을 모아도 될까요?
            </Text>
            <Body muted style={{ lineHeight: 22 }}>
              학교 데이터 분석 과제에 쓰려고, 앱을 한 번 실행할 때마다 성능·안정성 기록 한 줄을 남깁니다. 기록은
              이 기기에만 파일로 저장하고 어디로도 자동으로 보내지 않습니다. 직접 「기록 내보내기」를 눌러 보낼
              때만 전달됩니다.
            </Body>

            <Body style={{ fontWeight: '600' }}>기록하는 것</Body>
            <TelemetryItemList />

            <Body style={{ fontWeight: '600' }}>기록하지 않는 것</Body>
            <TelemetryNotRecordedList />

            <Caption style={{ lineHeight: 18 }}>
              언제든 설정의 「실행 기록」에서 끄거나 쌓인 기록을 지울 수 있습니다. 기록하지 않아도 앱은 그대로 쓸
              수 있습니다.
            </Caption>
          </ScrollView>

          {/* 버튼은 스크롤 밖에 — 작은 화면에서도 늘 보인다. */}
          <View
            style={{
              padding: spacing.lg,
              gap: spacing.sm,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
            }}
          >
            <Button
              label="동의하고 기록하기"
              icon="checkmark"
              full
              onPress={() => void choose(true)}
              loading={busy === 'grant'}
              disabled={busy !== null}
            />
            <Button
              label="기록하지 않기"
              variant="secondary"
              full
              onPress={() => void choose(false)}
              loading={busy === 'deny'}
              disabled={busy !== null}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '100%',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
