import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ROLE_DESCRIPTION, ROLE_LABEL, formatInviteCode, type InvitePreview } from '@listup/shared';
import { ApiError, api } from '../api/client';
import { markPendingInviteSeen, peekPendingInvite } from '../lib/invite-link';
import { fontSize, radius, spacing, useTheme } from '../theme';
import { Badge, Body, Caption, Card, Row } from './ui';

/** 초대 미리보기 — 어떤 저장소에 어떤 권한으로 들어가는지. 참여 화면과 로그인·가입 화면이 같이 쓴다. */
export function InviteSummary({ preview }: { preview: InvitePreview }) {
  const { colors } = useTheme();
  return (
    <>
      <Row gap={spacing.sm}>
        <Ionicons name="folder" size={22} color={colors.accent} />
        <Body style={{ fontWeight: '700', fontSize: fontSize.lg, flex: 1 }}>{preview.repo.name}</Body>
      </Row>

      {preview.repo.description ? <Body muted>{preview.repo.description}</Body> : null}

      <Row gap={spacing.md} wrap>
        <Caption>소유자 {preview.owner.displayName}</Caption>
        <Caption>멤버 {preview.memberCount}명</Caption>
        <Caption>파일 {preview.fileCount}개</Caption>
      </Row>

      <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs }}>
        <Row gap={spacing.sm}>
          <Badge label={`${ROLE_LABEL[preview.role]} 권한으로 참여`} tone="accent" />
        </Row>
        <Caption>{ROLE_DESCRIPTION[preview.role]}</Caption>
      </View>
    </>
  );
}

/**
 * 로그인하지 않은 채 들고 있는 초대 코드의 미리보기(서버 수준 5부터 로그인 없이 열린다). 보여 주고 나면
 * 로그인·가입 뒤 다시 묻지 않고 바로 참여한다. 옛 서버(401)면 미리보기 없이 코드만으로 이어 간다.
 */
export function usePendingInvitePreview(code: string | null) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    api
      .previewInvite(code)
      .then(({ invite }) => {
        if (cancelled) return;
        setPreview(invite);
        markPendingInviteSeen(code);
      })
      .catch((err) => {
        // 401 은 로그인이 있어야 미리보기를 주는 옛 서버 — 알릴 일이 아니다.
        if (!cancelled && err instanceof ApiError && err.status !== 401) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  return { preview, error };
}

/** 로그인·가입 화면 위의 "이 초대로 들어갑니다" 안내. */
export function PendingInviteNote({ action }: { action: '로그인' | '가입' }) {
  const code = peekPendingInvite();
  const { preview, error } = usePendingInvitePreview(code);
  if (!code) return null;
  if (!preview) {
    return (
      <Body muted>
        {action === '가입' ? '가입하면' : '로그인하면'} 초대 코드 {formatInviteCode(code)} 로 참여를 이어 갑니다.
        {error ? ` (${error})` : ''}
      </Body>
    );
  }
  return (
    <Card style={{ gap: spacing.md }}>
      <InviteSummary preview={preview} />
      <Caption>{action === '가입' ? '가입하면' : '로그인하면'} 이 저장소에 바로 참여합니다.</Caption>
    </Card>
  );
}
