import { Ionicons } from '@expo/vector-icons';
import { Link, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
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
import { RememberLogin } from '../src/components/RememberLogin';
import { credentialsSupported, loadLogin } from '../src/lib/credentials';
import { useAuth } from '../src/state/auth';
import { ApiError, IS_CLIENT_BUILD } from '../src/api/client';
import { openServerList } from '../src/lib/server-list';
import { serverTitle } from '../src/state/servers';
import { radius, spacing, useTheme } from '../src/theme';

export default function LoginScreen() {
  const { login, activeServer, servers } = useAuth();
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(credentialsSupported);

  // 이 서버에 저장된 계정이 있으면 채워 둔다. 직접 로그아웃했거나 비밀번호가 바뀌어 자동 로그인이
  // 안 된 경우, 여기서 한 번 누르면 된다. 비밀번호가 지워진 경우(바뀌었음)는 이메일만 채운다.
  const activeId = activeServer?.id;
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void loadLogin(activeId).then((saved) => {
      if (cancelled || !saved) return;
      setEmail(saved.email);
      setPassword(saved.password ?? '');
      setRemember(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password, { remember });
      // index 가 로그인 여부를 보고 저장소 목록으로 보낸다. 로그인 화면은 스택에 남지 않는다.
      router.replace('/');
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

            <RememberLogin value={remember} onChange={setRemember} />

            {error ? <ErrorNotice message={error} /> : null}

            <Button label="로그인" onPress={submit} loading={busy} full />

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
              <Body muted>계정이 없으신가요?</Body>
              <Link href="/signup" style={{ color: colors.accent, fontWeight: '600' }}>
                회원가입
              </Link>
            </View>
          </Card>

          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: spacing.xs,
            }}
          >
            <Body muted style={{ fontSize: 12 }}>
              서버: {activeServer ? serverTitle(activeServer) : '고르지 않음'}
            </Body>
            <Pressable onPress={openServerList} accessibilityRole="link" hitSlop={8}>
              <Body style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>
                {IS_CLIENT_BUILD || servers.length > 1 ? '다른 서버' : '바꾸기'}
              </Body>
            </Pressable>
          </View>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
