import { Pressable, Switch, View } from 'react-native';
import { credentialsSupported } from '../lib/credentials';
import { spacing, useTheme } from '../theme';
import { Body, Caption } from './ui';

/**
 * "이 기기에 로그인 정보 저장" 스위치. 로그인 정보를 안전하게 저장할 수 없는 클라이언트
 * (서버가 주는 웹)에서는 보이지 않는다 — 그곳은 브라우저 비밀번호 관리자에 맡긴다.
 */
export function RememberLogin({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const { colors } = useTheme();
  if (!credentialsSupported()) return null;

  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      // accessibilityState 는 웹에서 aria-checked 로 옮겨지지 않아, aria 속성으로 준다(네이티브도 같게 동작).
      aria-checked={value}
      accessibilityLabel="이 기기에 로그인 정보 저장"
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Body>이 기기에 로그인 정보 저장</Body>
        <Caption>로그인이 풀리면 저장된 계정으로 다시 로그인합니다. 기기에 암호화해 둡니다.</Caption>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.border }}
        // 스위치 역할은 바깥 줄이 맡는다. 안쪽 스위치까지 읽히면 같은 스위치가 두 번 나온다.
        aria-hidden
      />
    </Pressable>
  );
}
