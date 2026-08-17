import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
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
import { API_BASE_URL, ApiError, api } from '../src/api/client';
import { confirmAction, notify } from '../src/lib/dialogs';
import { useAuth } from '../src/state/auth';
import { spacing } from '../src/theme';

export default function SettingsScreen() {
  const { user, updateProfile, logout } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

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
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      notify('비밀번호를 바꿨습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '비밀번호를 바꾸지 못했습니다.');
    } finally {
      setSavingPassword(false);
    }
  };

  const signOut = async () => {
    const ok = await confirmAction({
      title: '로그아웃할까요?',
      message: '다시 로그인하면 저장소는 그대로 남아 있습니다.',
      confirmLabel: '로그아웃',
    });
    if (!ok) return;
    await logout();
    router.replace('/login');
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
          <Input value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
        </Field>
        <Field label="새 비밀번호" hint="8자 이상">
          <Input value={newPassword} onChangeText={setNewPassword} secureTextEntry />
        </Field>
        <Button
          label="비밀번호 변경"
          onPress={savePassword}
          loading={savingPassword}
          disabled={!currentPassword || !newPassword}
        />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Caption>서버</Caption>
          <Caption>{API_BASE_URL}</Caption>
        </Row>
        <Button label="로그아웃" variant="danger" icon="log-out-outline" onPress={signOut} full />
      </Card>
    </Screen>
  );
}
