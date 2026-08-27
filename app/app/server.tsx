import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
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
import {
  API_URL_STORAGE_KEY,
  DEFAULT_API_BASE_URL,
  getApiBaseUrl,
  setApiBaseUrl,
} from '../src/api/client';
import { notify } from '../src/lib/dialogs';
import { useAuth } from '../src/state/auth';
import { monoFont, spacing, useTheme } from '../src/theme';

/** 연결 확인 응답을 기다리는 최대 시간. */
const HEALTH_TIMEOUT_MS = 5_000;

/** 입력한 주소를 정리한다. http(s):// 로 시작하지 않으면 null. 끝 슬래시는 뗀다. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimmed) ? trimmed : null;
}

/** GET {url}/api/health 가 ok:true 를 돌려주는지 확인한다. */
async function checkServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 네이티브 빌드에서도 서버 주소를 바꿀 수 있게 하는 화면. 로그인 전후 모두 들어올 수 있다. */
export default function ServerScreen() {
  const { colors } = useTheme();
  const { logout } = useAuth();
  const [current, setCurrent] = useState(getApiBaseUrl);
  const [input, setInput] = useState(current);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 연결 확인에 성공한 주소. 입력이 바뀌면 다시 확인해야 한다. */
  const [verified, setVerified] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeUrl(input);
  const canSave = verified !== null && verified === normalized;
  const isDefault = current === DEFAULT_API_BASE_URL;

  const onChange = (text: string) => {
    setInput(text);
    setVerified(null);
    setError(null);
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
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
      const ok = await checkServer(normalized);
      if (ok) {
        setVerified(normalized);
      } else {
        setVerified(null);
        setError(
          `${normalized} 에서 ListUp 서버 응답을 받지 못했습니다.\n주소와 서버 상태를 확인해 주세요.`,
        );
      }
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (saving || !verified || verified !== normalized) return;
    setSaving(true);
    try {
      // 저장이 실패하면 이번 실행의 주소도 바꾸지 않는다 (표시와 실제가 어긋나지 않게).
      await AsyncStorage.setItem(API_URL_STORAGE_KEY, verified);
    } catch {
      setError('서버 주소를 저장하지 못했습니다.');
      setSaving(false);
      return;
    }
    try {
      // 다른 서버로 바꿀 때는 세션을 지운다 — 지금 서버에서 받은 토큰이 새 서버로 전송되면 안 된다.
      if (verified !== current) await logout();
      setApiBaseUrl(verified);
      leave();
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    // 주소가 실제로 바뀌면 세션도 지운다 — 토큰은 발급한 서버에만 보내야 한다.
    if (current !== DEFAULT_API_BASE_URL) await logout();
    setApiBaseUrl(null);
    try {
      await AsyncStorage.removeItem(API_URL_STORAGE_KEY);
    } catch {
      // 저장소 정리에 실패해도 이번 실행에서는 기본값이 적용된다.
    }
    setCurrent(DEFAULT_API_BASE_URL);
    setInput(DEFAULT_API_BASE_URL);
    setVerified(null);
    setError(null);
    notify('기본 서버 주소로 되돌렸습니다.');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ gap: spacing.sm }}>
          <Title>서버 주소</Title>
          <Subtitle>
            ListUp 서버가 다른 곳에서 돌고 있다면 여기서 주소를 바꿉니다. 모바일과 PC 가 같은 서버를
            봐야 같은 저장소가 보입니다.
          </Subtitle>
        </View>

        <Card style={{ gap: spacing.xs }}>
          <Caption>현재 주소</Caption>
          {/* 웹을 서버와 같은 오리진으로 빌드하면 주소가 빈 문자열이라 말로 알려준다. */}
          <Body style={{ fontFamily: monoFont }}>{current || '이 사이트와 같은 주소'}</Body>
          <Caption>
            {isDefault
              ? '기본값을 쓰고 있습니다.'
              : `기본값: ${DEFAULT_API_BASE_URL || '이 사이트와 같은 주소'}`}
          </Caption>
        </Card>

        <Card style={{ gap: spacing.lg }}>
          <Field label="새 주소" hint="예: http://192.168.0.10:4000 또는 https://listup.example.com">
            <Input
              value={input}
              onChangeText={onChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              placeholder="http://"
              onSubmitEditing={check}
            />
          </Field>

          {error ? <ErrorNotice message={error} /> : null}
          {canSave ? (
            <Body style={{ color: colors.success }}>연결을 확인했습니다. 저장하면 이 주소를 씁니다.</Body>
          ) : null}

          <Row wrap>
            <Button
              label="연결 확인"
              variant="secondary"
              icon="pulse-outline"
              onPress={check}
              loading={checking}
              disabled={!normalized}
            />
            <Button label="저장" icon="checkmark" onPress={save} loading={saving} disabled={!canSave} />
          </Row>
        </Card>

        <Card style={{ gap: spacing.md }}>
          <Body muted>앱에 설정된 기본 주소로 되돌립니다.</Body>
          <Button
            label="기본값으로"
            variant="ghost"
            icon="refresh-outline"
            onPress={reset}
            disabled={isDefault}
          />
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}
