import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { parseInviteCode, parseRecoveryCode } from '@listup/shared';
import { Body, Button, Card, ErrorNotice, Field, Input, PasswordInput, Screen, Subtitle, Title } from '../src/components/ui';
import { ApiError } from '../src/api/client';
import { PendingInviteNote } from '../src/components/InviteSummary';
import { RememberLogin } from '../src/components/RememberLogin';
import { credentialsSupported } from '../src/lib/credentials';
import { useAuth } from '../src/state/auth';
import { serverTitle } from '../src/state/servers';
import { fontSize, spacing, useTheme } from '../src/theme';

/**
 * 비밀번호를 잊었을 때 — 두 가지 코드를 받는다(서버가 모양으로 가른다).
 * - 복구 코드: 내 정보에서 미리 만들어 둔 것(`ABCD-EFGH-JKMN-PQRS`). 아이디를 비워도 된다 — 아이디 찾기도 이 길.
 * - 재설정 코드: 서버를 돌리는 사람이 발급(`npm run reset-password -- <아이디>`, PC 앱). 아이디와 함께, 30분.
 * 성공하면 바로 로그인되고, 찾은 아이디·남은 복구 코드는 저장소 목록이 알린다(lib/account-notice.ts).
 */
export default function ResetPasswordScreen() {
  const { resetPassword, activeServer } = useAuth();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ email?: string; find?: string }>();
  /** 아이디 찾기 화면에서 왔다 — 아이디 칸을 비워 두는 것이 기본이라고 알린다. */
  const findingId = params.find === '1';
  const [email, setEmail] = useState(typeof params.email === 'string' ? params.email : '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(credentialsSupported);

  const submit = async () => {
    if (busy) return;
    setError(null);
    const isRecovery = parseRecoveryCode(code) !== null;
    if (!code.trim()) {
      setError('복구 코드나 재설정 코드를 넣어 주세요.');
      return;
    }
    if (!isRecovery && parseInviteCode(code) === null) {
      setError(
        '코드 모양이 아닙니다. 복구 코드는 4글자씩 네 묶음(ABCD-EFGH-JKMN-PQRS), 운영자의 재설정 코드는 5글자씩 두 묶음(ABCDE-12345)입니다.',
      );
      return;
    }
    if (!isRecovery && !email.trim()) {
      setError('서버 운영자에게 받은 재설정 코드는 아이디와 함께 넣어 주세요. 아이디가 기억나지 않으면 복구 코드를 쓰거나 운영자에게 물어보세요.');
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
          <Title>{findingId ? '아이디 찾기' : '비밀번호 재설정'}</Title>
          <Subtitle>
            {findingId
              ? '복구 코드만 넣으면 아이디를 알려 드리고, 새 비밀번호로 바로 로그인합니다.'
              : '내 정보에서 미리 만들어 둔 복구 코드가 있으면 그것을, 없으면 서버를 돌리는 사람에게 받은 재설정 코드를 넣어 주세요.'}{' '}
            계정은 서버마다 따로입니다{activeServer ? ` (지금 서버: ${serverTitle(activeServer)})` : ''}.
          </Subtitle>
        </View>

        <PendingInviteNote action="로그인" />
        <Card style={{ gap: spacing.lg }}>
          <Field label="아이디" hint="복구 코드를 쓰면 비워도 됩니다.">
            <Input
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              placeholder="아이디"
            />
          </Field>
          <Field label="복구 코드 또는 재설정 코드" hint="하이픈·띄어쓰기·소문자는 상관없습니다. 각 코드는 한 번만 쓸 수 있습니다.">
            <Input
              value={code}
              onChangeText={setCode}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="ABCD-EFGH-JKMN-PQRS 또는 ABCDE-12345"
            />
          </Field>
          <Field label="새 비밀번호" hint="8자 이상. 바꾸면 다른 기기의 로그인은 모두 끊깁니다.">
            <PasswordInput
              value={password}
              onChangeText={setPassword}
              autoComplete="new-password"
              onSubmitEditing={submit}
            />
          </Field>

          <RememberLogin value={remember} onChange={setRemember} />

          {error ? <ErrorNotice message={error} /> : null}

          <Button label="새 비밀번호로 로그인" onPress={submit} loading={busy} full />
        </Card>

        <View style={{ gap: spacing.xs }}>
          <Body muted style={{ fontSize: fontSize.xs }}>
            복구 코드도 없나요? 서버를 돌리는 사람에게 재설정 코드를 부탁하세요 — PC 앱의 「이 PC 에서 서버 열기」나 서버
            폴더의 npm run reset-password -- 아이디 로 발급합니다.
          </Body>
          <Pressable onPress={() => router.push('/help')} accessibilityRole="link" hitSlop={12}>
            <Body style={{ color: colors.accent, fontSize: fontSize.xs, fontWeight: '600' }}>도움말 보기</Body>
          </Pressable>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
