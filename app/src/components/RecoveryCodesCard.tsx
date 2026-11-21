import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatRelativeTime, type RecoveryCodesStatus } from '@listup/shared';
import { ApiError, api } from '../api/client';
import { confirmAction, notifySuccess } from '../lib/dialogs';
import { fontSize, monoFont, radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption, Card, ErrorNotice, Field, Notice, PasswordInput } from './ui';

/** 남은 코드가 이만큼 이하면 새로 만들라고 권한다. */
const LOW_CODES = 2;

/**
 * 복구 코드 — 비밀번호를 잊으면 운영자 없이 새 비밀번호를 정하는 코드(API_LEVEL 7). 원문은 만든 직후 한 번만
 * 보여주고, 그 뒤로는 남은 수만 본다. 만들 때 현재 비밀번호를 다시 묻는다(서버가 확인한다).
 */
export function RecoveryCodesCard() {
  const { colors } = useTheme();
  const [status, setStatus] = useState<RecoveryCodesStatus | null>(null);
  /** 서버가 복구 코드를 모른다(404, 1.10 까지). */
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 방금 만든 원문. "적어 두었습니다"를 누르면 지운다. */
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await api.recoveryCodes());
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setUnsupported(true);
      else setLoadError(err instanceof ApiError ? err.message : '복구 코드 상태를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    if (status && status.remaining > 0) {
      const ok = await confirmAction({
        title: '복구 코드를 새로 만들까요?',
        message: `지금 남은 ${status.remaining}개는 더 쓸 수 없게 됩니다.`,
        confirmLabel: '새로 만들기',
        destructive: true,
      });
      if (!ok) return;
    }
    setError(null);
    setAsking(true);
  };

  const issue = async () => {
    if (busy || !password) return;
    setError(null);
    setBusy(true);
    try {
      const issued = await api.issueRecoveryCodes({ currentPassword: password });
      setCodes(issued.codes);
      setPassword('');
      setAsking(false);
      setStatus({ remaining: issued.codes.length, total: issued.codes.length, createdAt: issued.createdAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '복구 코드를 만들지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const copyAll = async () => {
    if (!codes) return;
    await Clipboard.setStringAsync(`ListUp 복구 코드 — 각 코드는 한 번만 쓸 수 있습니다\n${codes.join('\n')}`);
    notifySuccess('복구 코드를 복사했습니다.', '비밀번호 관리자나 안전한 곳에 붙여 넣으세요.');
  };

  return (
    <Card style={{ gap: spacing.md }}>
      <Body heading style={{ fontWeight: '600' }}>
        복구 코드
      </Body>
      <Caption>
        비밀번호를 잊었을 때 서버 운영자 없이 새 비밀번호를 정하는 코드입니다. 코드 하나로 아이디도 찾을 수 있습니다.
        종이나 비밀번호 관리자처럼 이 기기 밖의 안전한 곳에 적어 두세요.
      </Caption>

      {unsupported ? (
        <Notice tone="warning" title="이 서버에는 아직 복구 코드가 없습니다">
          서버 주인에게 ListUp 서버를 업데이트해 달라고 부탁하세요. 그때까지 비밀번호를 잊으면 서버 운영자에게 재설정
          코드를 받아야 합니다.
        </Notice>
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={() => void load()} />
      ) : codes ? (
        <>
          <Notice tone="success" title="새 복구 코드 10개를 만들었습니다">
            이 화면을 떠나면 다시 볼 수 없습니다. 지금 적어 두세요. 각 코드는 한 번만 쓸 수 있습니다.
          </Notice>
          <View
            accessibilityLabel="새 복구 코드 목록"
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: spacing.sm,
              backgroundColor: colors.surfaceAlt,
              borderRadius: radius.md,
              padding: spacing.md,
            }}
          >
            {codes.map((code) => (
              <Body key={code} selectable style={{ fontFamily: monoFont, fontSize: fontSize.sm, minWidth: 170 }}>
                {code}
              </Body>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            <Button label="모두 복사" icon="copy-outline" variant="secondary" onPress={() => void copyAll()} />
            <Button label="적어 두었습니다" icon="checkmark" onPress={() => setCodes(null)} />
          </View>
        </>
      ) : status ? (
        <>
          {status.total === 0 ? (
            <Body muted>아직 만들지 않았습니다.</Body>
          ) : (
            <Body muted>
              {status.remaining}개 남음 / {status.total}개
              {status.createdAt ? ` · ${formatRelativeTime(status.createdAt)} 만듦` : ''}
            </Body>
          )}
          {status.total > 0 && status.remaining <= LOW_CODES ? (
            <Notice tone="warning" title={status.remaining === 0 ? '남은 복구 코드가 없습니다' : '복구 코드가 얼마 남지 않았습니다'}>
              새로 만들어 두세요. 새로 만들면 남은 코드는 더 쓸 수 없습니다.
            </Notice>
          ) : null}

          {asking ? (
            <>
              <Field label="현재 비밀번호" hint="본인인지 한 번 더 확인합니다.">
                <PasswordInput
                  value={password}
                  onChangeText={setPassword}
                  autoComplete="current-password"
                  textContentType="password"
                  onSubmitEditing={() => void issue()}
                />
              </Field>
              {error ? <ErrorNotice message={error} /> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                <Button
                  label="취소"
                  variant="ghost"
                  onPress={() => {
                    setAsking(false);
                    setPassword('');
                    setError(null);
                  }}
                  disabled={busy}
                />
                <Button label="복구 코드 만들기" icon="key-outline" onPress={() => void issue()} loading={busy} disabled={!password} />
              </View>
            </>
          ) : (
            <Button
              label={status.total === 0 ? '복구 코드 만들기' : '복구 코드 새로 만들기'}
              icon="key-outline"
              variant={status.total === 0 ? 'primary' : 'secondary'}
              onPress={() => void start()}
            />
          )}
        </>
      ) : (
        <Caption>불러오는 중…</Caption>
      )}
    </Card>
  );
}
