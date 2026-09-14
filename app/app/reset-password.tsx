import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Body, Button, Card, ErrorNotice, Field, Input, Screen, Subtitle, Title } from '../src/components/ui';
import { ApiError } from '../src/api/client';
import { RememberLogin } from '../src/components/RememberLogin';
import { credentialsSupported } from '../src/lib/credentials';
import { useAuth } from '../src/state/auth';
import { serverTitle } from '../src/state/servers';
import { spacing } from '../src/theme';

/**
 * 비밀번호를 잊었을 때 — 계정은 서버마다 따로라, 그 서버를 돌리는 사람에게 재설정 코드를 받는다
 * (`npm run reset-password -- <이메일>`). 코드와 새 비밀번호를 넣으면 바로 로그인된다.
 */
export default function ResetPasswordScreen() {
  const { resetPassword, activeServer } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === 'string' ? params.email : '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(credentialsSupported);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!email.trim() || !code.trim()) {
      setError('이메일과 재설정 코드를 넣어 주세요.');
      return;
    }
    if (password.length < 8) {
      setError('비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    setBusy(true);
    try {
      await resetPassword(email.trim(), code.trim(), password, { remember });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '비밀번호를 바꾸지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ gap: spacing.sm }}>
          <Title>비밀번호 재설정</Title>
          <Subtitle>
            계정은 서버마다 따로입니다. {activeServer ? `${serverTitle(activeServer)} ` : ''}서버를 돌리는 사람에게
            재설정 코드를 받아 넣어 주세요. 코드는 30분 동안 한 번 쓸 수 있습니다.
          </Subtitle>
        </View>

        <Card style={{ gap: spacing.lg }}>
          <Field label="이메일">
            <Input
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
            />
          </Field>
          <Field label="재설정 코드">
            <Input
              value={code}
              onChangeText={setCode}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="XXXXX-XXXXX"
            />
          </Field>
          <Field label="새 비밀번호" hint="8자 이상. 바꾸면 다른 기기의 로그인은 모두 끊깁니다.">
            <Input
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              onSubmitEditing={submit}
            />
          </Field>

          <RememberLogin value={remember} onChange={setRemember} />

          {error ? <ErrorNotice message={error} /> : null}

          <Button label="새 비밀번호로 로그인" onPress={submit} loading={busy} full />
        </Card>

        <Body muted style={{ fontSize: 12 }}>
          서버를 돌리는 사람이라면: 서버 폴더에서 npm run reset-password -- 이메일
        </Body>
      </Screen>
    </KeyboardAvoidingView>
  );
}
