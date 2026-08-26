import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button, Card, ErrorNotice, Field, Input, Screen, Subtitle, Title } from '../src/components/ui';
import { ApiError } from '../src/api/client';
import { useAuth } from '../src/state/auth';
import { spacing } from '../src/theme';

export default function SignupScreen() {
  const { signup } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);

    if (password.length < 8) {
      setError('비밀번호는 8자 이상이어야 합니다.');
      return;
    }

    setBusy(true);
    try {
      await signup(email.trim(), password, displayName.trim());
      // index 가 저장소 목록으로 보낸다. 로그인·가입 화면은 스택에 남지 않는다.
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '회원가입에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ gap: spacing.sm }}>
          <Title>계정 만들기</Title>
          <Subtitle>만든 계정으로 모바일과 PC 어디서든 같은 저장소를 볼 수 있습니다.</Subtitle>
        </View>

        <Card style={{ gap: spacing.lg }}>
          <Field label="이름" hint="다른 참여자에게 보이는 이름입니다.">
            <Input
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="홍길동"
              autoComplete="name"
            />
          </Field>
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
          <Field label="비밀번호" hint="8자 이상">
            <Input
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              onSubmitEditing={submit}
            />
          </Field>

          {error ? <ErrorNotice message={error} /> : null}

          <Button label="가입하고 시작하기" onPress={submit} loading={busy} full />
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}
