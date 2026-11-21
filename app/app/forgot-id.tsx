import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import { Body, Button, Caption, Card, Row, Screen, Subtitle, Title } from '../src/components/ui';
import { useAuth } from '../src/state/auth';
import { serverTitle } from '../src/state/servers';
import { monoFont, spacing, useTheme } from '../src/theme';

/**
 * 아이디를 잊었을 때 — 이메일이 없는 시스템이라(1.6.0 에 아이디로 바꿈) 메일로 알려 줄 수 없다. 길은 셋:
 * 복구 코드(코드만으로 서버가 그 사람을 찾는다), 같은 저장소 멤버(멤버 화면에 아이디가 보인다), 서버 운영자.
 */
export default function ForgotIdScreen() {
  const { activeServer } = useAuth();
  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>아이디를 잊었나요?</Title>
        <Subtitle>
          계정은 서버마다 따로입니다{activeServer ? ` (지금 서버: ${serverTitle(activeServer)})` : ''}. 아이디는
          대소문자를 가리지 않고, 예전에 이메일로 가입했다면 그 이메일이 아이디입니다.
        </Subtitle>
      </View>

      <Way icon="key-outline" title="복구 코드가 있다면">
        <Caption>
          내 정보에서 만들어 둔 복구 코드 하나만 넣으면 아이디를 알려 드리고, 새 비밀번호로 바로 로그인합니다.
        </Caption>
        <Button
          label="복구 코드로 아이디 찾기"
          icon="search-outline"
          onPress={() => router.push({ pathname: '/reset-password', params: { find: '1' } })}
        />
      </Way>

      <Way icon="people-outline" title="같은 저장소를 쓰는 사람에게">
        <Caption>
          저장소의 「멤버」 화면에는 멤버마다 아이디가 보입니다. 같은 저장소를 쓰는 사람에게 내 아이디를 확인해 달라고
          부탁하세요.
        </Caption>
      </Way>

      <Way icon="server-outline" title="서버를 돌리는 사람에게">
        <Caption>운영자는 이름으로 계정을 찾고, 비밀번호 재설정 코드도 줄 수 있습니다. 서버 폴더에서:</Caption>
        <Body selectable style={{ fontFamily: monoFont }}>
          npm run reset-password -- --find 내이름
        </Body>
      </Way>
    </Screen>
  );
}

function Way({
  icon,
  title,
  children,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Card style={{ gap: spacing.md }}>
      <Row gap={spacing.sm}>
        <Ionicons name={icon} size={20} color={colors.accent} />
        <Body heading style={{ fontWeight: '600', flex: 1 }}>
          {title}
        </Body>
      </Row>
      {children}
    </Card>
  );
}
