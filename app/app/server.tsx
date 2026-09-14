import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
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
import { confirmAction } from '../src/lib/dialogs';
import { openReleasePage, updateChecksEnabled } from '../src/lib/updates';
import { useAuth } from '../src/state/auth';
import {
  checkServer,
  describeCheck,
  describeUrl,
  isDefaultServer,
  normalizeServerUrl,
  serverUrl,
} from '../src/state/servers';
import { monoFont, spacing, useTheme } from '../src/theme';

/**
 * 서버 추가·수정 폼. `?id=` 가 있으면 그 서버를 고친다. 로그인 전후 모두 들어올 수 있다.
 * 새 서버를 더하면 바로 그 서버로 들어간다 — 서버를 더하는 이유가 들어가려는 것이기 때문이다.
 */
export default function ServerFormScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { servers, activeServer, saveServer, switchServer, removeServer } = useAuth();
  const editing = id ? servers.find((entry) => entry.id === id) : undefined;
  const isDefault = editing ? isDefaultServer(editing) : false;

  const [label, setLabel] = useState(editing?.label ?? '');
  const [input, setInput] = useState(editing ? serverUrl(editing) : '');
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 연결 확인에 성공한 주소. 입력이 바뀌면 다시 확인해야 한다. */
  const [verified, setVerified] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalized = isDefault ? serverUrl(editing!) : normalizeServerUrl(input);
  const urlChanged = !editing || (!isDefault && normalized !== editing.url);
  // 주소가 그대로면(이름만 바꿀 때) 다시 확인하지 않아도 된다.
  const canSave = !saving && normalized !== null && (!urlChanged || verified === normalized);

  if (id && !editing) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '서버' }} />
        <ErrorNotice message="목록에 없는 서버입니다." />
        <Button label="서버 목록으로" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const onChangeUrl = (text: string) => {
    setInput(text);
    setVerified(null);
    setError(null);
  };

  const check = async () => {
    if (checking) return;
    setError(null);
    if (!normalized) {
      setError('주소는 http:// 또는 https:// 로 시작해야 합니다.');
      return;
    }
    setChecking(true);
    try {
      // 닿지 않거나 API 버전이 다르면 저장하지 못하게 한다.
      const result = await checkServer(normalized);
      const problem = describeCheck(result, normalized);
      setVerified(problem ? null : normalized);
      setError(problem);
      // 앱이 이 서버보다 오래됐다 — 업데이트가 꼭 필요하므로 릴리즈 페이지를 바로 연다.
      if (result.status === 'app-older' && updateChecksEnabled()) void openReleasePage();
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!canSave || normalized === null) return;
    // 주소를 바꾸면 그 서버의 토큰을 지운다 — 토큰은 발급한 서버에만 보낸다.
    if (editing && urlChanged && editing.token) {
      const ok = await confirmAction({
        title: '주소를 바꿀까요?',
        message: '주소를 바꾸면 이 서버에서 로그아웃됩니다. 새 주소에서 다시 로그인해야 합니다.',
        confirmLabel: '바꾸기',
      });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      // 새 서버로 들어가거나 지금 서버의 주소를 바꾸면 _layout 이 스택을 비우고 그 서버로
      // 들여보낸다. 그 밖의 수정은 목록으로 돌아간다.
      const savedId = await saveServer({ id: editing?.id, url: normalized, label });
      if (!editing) await switchServer(savedId);
      else if (!(urlChanged && editing.id === activeServer?.id)) router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : '서버를 저장하지 못했습니다.');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || isDefault) return;
    const ok = await confirmAction({
      title: '이 서버를 목록에서 지울까요?',
      message:
        '이 기기에서 기억하던 주소와 로그인만 지웁니다. 서버의 계정과 저장소는 그대로 남습니다.',
      confirmLabel: '지우기',
      destructive: true,
    });
    if (!ok) return;
    const wasActive = editing.id === activeServer?.id;
    try {
      // 지금 서버를 지우면 기본 서버로 새로 들어간다(_layout 이 이동). 아니면 목록으로.
      await removeServer(editing.id);
      if (!wasActive) router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : '서버를 지우지 못했습니다.');
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <Stack.Screen options={{ title: editing ? '서버 설정' : '서버 추가' }} />
        <View style={{ gap: spacing.sm }}>
          <Title>{editing ? '서버 설정' : '서버 추가'}</Title>
          <Subtitle>
            {editing
              ? '목록에 보일 이름과 주소를 고칩니다.'
              : '들어갈 ListUp 서버의 주소를 넣습니다. 초대 코드를 준 사람에게 주소를 받으세요.'}
          </Subtitle>
        </View>

        <Card style={{ gap: spacing.lg }}>
          <Field label="이름" hint="비워 두면 주소가 이름 자리에 보입니다.">
            <Input
              value={label}
              onChangeText={setLabel}
              placeholder={isDefault ? '기본 서버' : '예: 우리집 음악서버'}
              maxLength={60}
            />
          </Field>

          {isDefault ? (
            <View style={{ gap: spacing.xs }}>
              <Caption>주소</Caption>
              <Body style={{ fontFamily: monoFont }}>{describeUrl(normalized ?? '')}</Body>
              <Caption>기본 서버는 이 앱이 정한 주소를 따라갑니다. 주소는 바꿀 수 없습니다.</Caption>
            </View>
          ) : (
            <Field label="주소" hint="예: http://192.168.0.10:4000 또는 https://listup.example.com">
              <Input
                value={input}
                onChangeText={onChangeUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
                placeholder="http://"
                onSubmitEditing={check}
              />
            </Field>
          )}

          {error ? <ErrorNotice message={error} /> : null}
          {urlChanged && verified !== null && verified === normalized ? (
            <Body style={{ color: colors.success }}>
              {editing ? '연결을 확인했습니다.' : '연결을 확인했습니다. 저장하면 이 서버로 들어갑니다.'}
            </Body>
          ) : null}

          <Row wrap>
            {!isDefault ? (
              <Button
                label="연결 확인"
                variant="secondary"
                icon="pulse-outline"
                onPress={check}
                loading={checking}
                disabled={!normalized || !urlChanged}
              />
            ) : null}
            <Button
              label={editing ? '저장' : '저장하고 들어가기'}
              icon="checkmark"
              onPress={save}
              loading={saving}
              disabled={!canSave}
            />
          </Row>
        </Card>

        {editing && !isDefault ? (
          <Card style={{ gap: spacing.md }}>
            <Body muted>이 기기의 서버 목록에서 지웁니다.</Body>
            <Button label="목록에서 지우기" variant="danger" icon="trash-outline" onPress={remove} />
          </Card>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
