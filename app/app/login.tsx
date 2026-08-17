import { Ionicons } from '@expo/vector-icons';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import {
  Body,
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { useAuth } from '../src/state/auth';
import { API_BASE_URL, ApiError } from '../src/api/client';
import { radius, spacing, useTheme } from '../src/theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      router.replace('/repos');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: spacing.xl, paddingTop: spacing.xxl }}>
          <View style={{ gap: spacing.sm, alignItems: 'center' }}>
            <View
              style={{
                width: 60,
                height: 60,
                borderRadius: radius.lg,
                backgroundColor: colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="folder-open" size={30} color={colors.accentText} />
            </View>
            <Title>ListUp</Title>
            <Subtitle style={{ textAlign: 'center' }}>
              초대 코드로 참여하는 파일 공유 협업 공간
            </Subtitle>
          </View>

          <Card style={{ gap: spacing.lg }}>
            <Field label="이메일">
              <Input
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                placeholder="you@example.com"
                inputMode="email"
                onSubmitEditing={submit}
              />
            </Field>
            <Field label="비밀번호">
              <Input
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="current-password"
                placeholder="8자 이상"
                onSubmitEditing={submit}
              />
            </Field>

            {error ? <ErrorNotice message={error} /> : null}

            <Button label="로그인" onPress={submit} loading={busy} full />

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
              <Body muted>계정이 없으신가요?</Body>
              <Link href="/signup" style={{ color: colors.accent, fontWeight: '600' }}>
                회원가입
              </Link>
            </View>
          </Card>

          <Body muted style={{ textAlign: 'center', fontSize: 12 }}>
            서버: {API_BASE_URL}
          </Body>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
