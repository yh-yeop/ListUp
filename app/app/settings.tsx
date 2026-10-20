import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
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
import { AppVersion } from '../src/components/AppVersion';
import { credentialsSupported, loadLogin, removeLogin } from '../src/lib/credentials';
import { hostSupported } from '../src/lib/desktop';
import { confirmAction, notifySuccess } from '../src/lib/dialogs';
import { chooseSaveFolder, getSaveFolder, saveFolderLabel, saveFolderSupported } from '../src/lib/save-folder';
import { useAuth } from '../src/state/auth';
import { openServerList } from '../src/lib/server-list';
import { serverTitle } from '../src/state/servers';
import { spacing, useTheme } from '../src/theme';


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
  const [saveFolder, setSaveFolder] = useState<string | null>(null);

  // 안드로이드: 받은 파일을 두는 폴더.
  useEffect(() => {
    if (!saveFolderSupported) return;
    let cancelled = false;
    void getSaveFolder().then((dir) => {
      if (!cancelled) setSaveFolder(dir ? saveFolderLabel(dir) : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeSaveFolder = async () => {
    const dir = await chooseSaveFolder();
    if (dir) setSaveFolder(saveFolderLabel(dir));
  };

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
      message: '이 서버에 저장한 아이디와 비밀번호를 이 기기에서 지웁니다. 지금 로그인은 그대로입니다.',
      confirmLabel: '지우기',
      destructive: true,
    });
    if (!ok) return;
    await removeLogin(activeId);
    setHasSavedLogin(false);
    notifySuccess('저장된 로그인 정보를 지웠습니다.');
  };

  const saveName = async () => {
    setError(null);
    setSavingName(true);
    try {
      await updateProfile(displayName.trim());
      notifySuccess('이름을 바꿨습니다.');
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
      notifySuccess('비밀번호를 바꿨습니다.', '다른 기기에서는 다시 로그인해야 합니다.');
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
        <Subtitle>{user ? `아이디 ${user.email}` : ''}</Subtitle>
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

        {hostSupported() ? (
          <Pressable
            onPress={() => router.push('/host')}
            accessibilityRole="button"
            accessibilityLabel="이 PC 서버 관리"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Row style={{ justifyContent: 'space-between' }}>
              <Caption>이 PC 에서 서버 열기</Caption>
              <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
            </Row>
          </Pressable>
        ) : null}

        {saveFolderSupported ? (
          <Pressable
            onPress={() => void changeSaveFolder()}
            accessibilityRole="button"
            accessibilityLabel="받은 파일 저장 폴더 바꾸기"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Row style={{ justifyContent: 'space-between' }}>
              <Caption>받은 파일 저장 폴더</Caption>
              <Row gap={spacing.xs} style={{ flexShrink: 1 }}>
                <Caption numberOfLines={1} style={{ flexShrink: 1 }}>
                  {saveFolder ?? '처음 받을 때 고름'}
                </Caption>
                <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
              </Row>
            </Row>
          </Pressable>
        ) : null}

        {/* 버전·업데이트, 그리고 AGPL-3.0 §13 의 소스 코드 링크 — 장식이 아니라 라이선스 조건이다. */}
        <AppVersion />

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
