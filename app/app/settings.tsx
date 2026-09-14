import { Ionicons } from '@expo/vector-icons';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Body,
  Button,
  Caption,
  Card,
  ErrorNotice,
  Field,
  Input,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { ApiError } from '../src/api/client';
import { credentialsSupported, loadLogin, removeLogin } from '../src/lib/credentials';
import {
  APP_VERSION,
  SOURCE_URL,
  checkForUpdate,
  openReleasePage,
  type LatestRelease,
} from '../src/lib/updates';
import { confirmAction, notify } from '../src/lib/dialogs';
import { useAuth } from '../src/state/auth';
import { openServerList } from '../src/lib/server-list';
import { serverTitle } from '../src/state/servers';
import { fontSize, spacing, useTheme } from '../src/theme';


export default function SettingsScreen() {
  const { user, updateProfile, logout, changePassword, activeServer } = useAuth();
  const { colors } = useTheme();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [hasSavedLogin, setHasSavedLogin] = useState(false);
  const [update, setUpdate] = useState<LatestRelease | null>(null);

  // 새 버전이 있으면 받을 수 있게 보여 준다(설치형 클라이언트만 확인한다).
  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((latest) => {
      if (!cancelled) setUpdate(latest);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeId = activeServer?.id;
  useEffect(() => {
    if (!activeId || !credentialsSupported()) return;
    let cancelled = false;
    void loadLogin(activeId).then((saved) => {
      if (!cancelled) setHasSavedLogin(saved !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const forgetLogin = async () => {
    if (!activeId) return;
    const ok = await confirmAction({
      title: '저장된 로그인 정보를 지울까요?',
      message: '이 서버에 저장한 이메일과 비밀번호를 이 기기에서 지웁니다. 지금 로그인은 그대로입니다.',
      confirmLabel: '지우기',
      destructive: true,
    });
    if (!ok) return;
    await removeLogin(activeId);
    setHasSavedLogin(false);
    notify('저장된 로그인 정보를 지웠습니다.');
  };

  const saveName = async () => {
    setError(null);
    setSavingName(true);
    try {
      await updateProfile(displayName.trim());
      notify('이름을 바꿨습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '이름을 바꾸지 못했습니다.');
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async () => {
    setError(null);
    if (newPassword.length < 8) {
      setError('새 비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    setSavingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      notify('비밀번호를 바꿨습니다.', '다른 기기에서는 다시 로그인해야 합니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '비밀번호를 바꾸지 못했습니다.');
    } finally {
      setSavingPassword(false);
    }
  };

  const signOut = async () => {
    const ok = await confirmAction({
      title: '로그아웃할까요?',
      message: '이 서버에서만 로그아웃합니다. 다시 로그인하면 저장소는 그대로 남아 있습니다.',
      confirmLabel: '로그아웃',
    });
    if (!ok) return;
    // 로그인 화면으로 가는 것은 _layout 의 보호 라우트가 처리한다.
    await logout();
  };

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>내 정보</Title>
        <Subtitle>{user?.email}</Subtitle>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <Card style={{ gap: spacing.lg }}>
        <Field label="이름" hint="저장소 멤버 목록과 변경 이력에 표시됩니다.">
          <Input value={displayName} onChangeText={setDisplayName} />
        </Field>
        <Button
          label="이름 저장"
          onPress={saveName}
          loading={savingName}
          disabled={!displayName.trim() || displayName.trim() === user?.displayName}
        />
      </Card>

      <Card style={{ gap: spacing.lg }}>
        <Body style={{ fontWeight: '600' }}>비밀번호 변경</Body>
        <Field label="현재 비밀번호">
          <Input
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
          />
        </Field>
        <Field label="새 비밀번호" hint="8자 이상">
          <Input
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            onSubmitEditing={savePassword}
          />
        </Field>
        <Button
          label="비밀번호 변경"
          onPress={savePassword}
          loading={savingPassword}
          disabled={!currentPassword || newPassword.length < 8}
        />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Pressable
          onPress={openServerList}
          accessibilityRole="button"
          accessibilityLabel="서버 목록 열기"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Row style={{ justifyContent: 'space-between' }}>
            <Caption>서버</Caption>
            <Row gap={spacing.xs} style={{ flexShrink: 1 }}>
              <Caption numberOfLines={1} style={{ flexShrink: 1 }}>
                {activeServer ? serverTitle(activeServer) : ''}
              </Caption>
              <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
            </Row>
          </Row>
        </Pressable>

        {/*
          AGPL-3.0 §13 — 네트워크로 이 프로그램을 쓰는 사람에게 소스를 받을 길을 알려야 한다.
          그래서 이 줄은 장식이 아니라 라이선스 조건을 지키는 부분이다.
        */}
        <Row style={{ justifyContent: 'space-between' }}>
          <Caption>ListUp {APP_VERSION} · AGPL-3.0</Caption>
          <Link
            href={SOURCE_URL}
            style={{ color: colors.accent, fontSize: fontSize.sm }}
            accessibilityLabel="소스 코드 보기"
          >
            소스 코드
          </Link>
        </Row>

        {update ? (
          <Button
            label={`새 버전 v${update.version} 받기`}
            icon="download-outline"
            onPress={() => void openReleasePage(update.url)}
            full
          />
        ) : null}

        {hasSavedLogin ? (
          <Button
            label="저장된 로그인 정보 지우기"
            variant="ghost"
            icon="key-outline"
            onPress={forgetLogin}
            full
          />
        ) : null}

        <Button label="로그아웃" variant="danger" icon="log-out-outline" onPress={signOut} full />
      </Card>
    </Screen>
  );
}
