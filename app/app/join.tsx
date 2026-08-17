import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  INVITE_CODE_LENGTH,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  formatInviteCode,
  parseInviteCode,
  type InvitePreview,
} from '@listup/shared';
import {
  Badge,
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
import { ApiError, api } from '../src/api/client';
import { fontSize, monoFont, spacing, useTheme } from '../src/theme';

export default function JoinScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ code?: string }>();
  const [raw, setRaw] = useState(params.code ?? '');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const normalized = parseInviteCode(raw);

  // 딥링크(listup://join?code=...)로 들어온 경우 바로 조회한다.
  useEffect(() => {
    if (params.code && parseInviteCode(params.code)) {
      void lookup(params.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.code]);

  async function lookup(code: string) {
    const clean = parseInviteCode(code);
    if (!clean) {
      setError(`초대 코드는 ${INVITE_CODE_LENGTH}자입니다. 다시 확인해 주세요.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { invite } = await api.previewInvite(clean);
      setPreview(invite);
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : '초대 코드를 확인하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.joinInvite(preview.code);
      router.replace(`/repo/${result.repo.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '참여하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>초대 코드로 참여</Title>
        <Subtitle>
          받은 코드를 입력하면 어떤 저장소인지 먼저 확인한 뒤 참여할 수 있습니다.
        </Subtitle>
      </View>

      <Card style={{ gap: spacing.lg }}>
        <Field label="초대 코드" hint="대소문자와 하이픈은 신경 쓰지 않아도 됩니다.">
          <Input
            value={raw}
            onChangeText={(value) => {
              setRaw(value);
              setPreview(null);
              setError(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="ABCDE-12345"
            maxLength={INVITE_CODE_LENGTH + 4}
            onSubmitEditing={() => void lookup(raw)}
            style={{
              fontFamily: monoFont,
              fontSize: fontSize.xl,
              letterSpacing: 2,
              textAlign: 'center',
            }}
          />
        </Field>

        {error ? <ErrorNotice message={error} /> : null}

        <Button
          label="코드 확인"
          onPress={() => void lookup(raw)}
          loading={busy && !preview}
          disabled={!normalized}
          full
        />
      </Card>

      {preview ? (
        <Card style={{ gap: spacing.md }}>
          <Row gap={spacing.sm}>
            <Ionicons name="folder" size={22} color={colors.accent} />
            <Body style={{ fontWeight: '700', fontSize: fontSize.lg, flex: 1 }}>
              {preview.repo.name}
            </Body>
          </Row>

          {preview.repo.description ? <Body muted>{preview.repo.description}</Body> : null}

          <Row gap={spacing.md} wrap>
            <Caption>소유자 {preview.owner.displayName}</Caption>
            <Caption>멤버 {preview.memberCount}명</Caption>
            <Caption>파일 {preview.fileCount}개</Caption>
          </Row>

          <View
            style={{
              backgroundColor: colors.surfaceAlt,
              borderRadius: spacing.md,
              padding: spacing.md,
              gap: spacing.xs,
            }}
          >
            <Row gap={spacing.sm}>
              <Badge label={`${ROLE_LABEL[preview.role]} 권한으로 참여`} tone="accent" />
            </Row>
            <Caption>{ROLE_DESCRIPTION[preview.role]}</Caption>
          </View>

          {preview.currentRole ? (
            <>
              <Body muted>
                이미 이 저장소에 {ROLE_LABEL[preview.currentRole]} 권한으로 참여하고 있습니다.
              </Body>
              <Button
                label="저장소 열기"
                onPress={() => router.replace(`/repo/${preview.repo.id}`)}
                full
              />
            </>
          ) : (
            <Button
              label={`${formatInviteCode(preview.code)} 코드로 참여하기`}
              onPress={join}
              loading={busy}
              full
            />
          )}
        </Card>
      ) : null}
    </Screen>
  );
}
