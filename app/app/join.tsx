import { Ionicons } from '@expo/vector-icons';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
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
import { ApiError, IS_CLIENT_BUILD, api } from '../src/api/client';
import { confirmAction } from '../src/lib/dialogs';
import { appLinkFor, clearPendingInvite, setPendingInvite } from '../src/lib/invite-link';
import { useAuth } from '../src/state/auth';
import { checkServer, describeCheck, normalizeServerUrl, serverUrl } from '../src/state/servers';
import { fontSize, monoFont, spacing, useTheme } from '../src/theme';

/**
 * 초대 코드로 참여. 초대 링크(`/join?code=`)나 앱 링크(`listup://join?server=&code=`)로도 들어온다.
 * 로그인 전에도 열린다 — 코드를 들고 로그인·가입으로 보냈다가, 끝나면 첫 화면이 여기로 다시 보낸다.
 * 앱 링크에 서버가 있으면 그 서버를 목록에 더하고(없으면) 들어간다.
 */
export default function JoinScreen() {
  const { colors } = useTheme();
  const { user, loading, activeServer, servers, saveServer, switchServer } = useAuth();
  const params = useLocalSearchParams<{ code?: string; server?: string }>();
  const [raw, setRaw] = useState(params.code ?? '');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handledServer = useRef(false);

  const normalized = parseInviteCode(raw);
  const linkCode = params.code ? parseInviteCode(params.code) : null;

  // 앱 링크로 다른 서버의 초대를 받았다 — 그 서버로 들어간 뒤 참여를 잇는다.
  useEffect(() => {
    if (loading || handledServer.current || !linkCode || !params.server) return;
    const target = normalizeServerUrl(params.server);
    if (!target) return;
    // 서버가 주는 웹에서는 지금 주소가 곧 서버다.
    if (!IS_CLIENT_BUILD && Platform.OS === 'web' && target === window.location.origin) return;
    if (activeServer && serverUrl(activeServer) === target) return;
    handledServer.current = true;
    void (async () => {
      const existing = servers.find((entry) => serverUrl(entry) === target);
      if (!existing) {
        const ok = await confirmAction({
          title: '이 서버를 목록에 더할까요?',
          message: `${target}\n초대받은 저장소가 이 서버에 있습니다. 목록에 더하고 들어갑니다.`,
          confirmLabel: '더하고 들어가기',
        });
        if (!ok) return;
      }
      setBusy(true);
      try {
        const problem = existing ? null : describeCheck(await checkServer(target), target);
        if (problem) {
          setError(problem);
          return;
        }
        const id = existing?.id ?? (await saveServer({ url: target, label: null }));
        // 들어가면 화면이 처음부터 다시 그려진다 — 코드를 들고 가서 로그인 뒤 여기로 돌아온다.
        setPendingInvite(linkCode);
        await switchServer(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : '서버에 들어가지 못했습니다.');
      } finally {
        setBusy(false);
      }
    })();
  }, [loading, linkCode, params.server, activeServer, servers, saveServer, switchServer]);

  // 링크가 가리키는 서버가 지금 서버일 때만(아니면 위에서 옮겨 간다) 로그인 뒤 코드를 바로 조회한다.
  const onLinkServer =
    !params.server ||
    normalizeServerUrl(params.server) === (activeServer ? serverUrl(activeServer) : null) ||
    (!IS_CLIENT_BUILD && Platform.OS === 'web' && normalizeServerUrl(params.server) === window.location.origin);
  // 들고 온 초대 코드는 참여하거나, 코드를 조회까지 한 이 화면을 떠날 때 지운다. 조회하자마자 지우면
  // 로그인 직후 첫 화면이 한 번 더 그려질 때(보호 라우트) 초대를 잃고 저장소 목록으로 간다. 서버를
  // 옮기느라 조회 전에 이 화면이 사라지는 경우에는 지우지 않는다 — 옮긴 서버에서 로그인한 뒤 이어 간다.
  const consumed = useRef(false);
  useEffect(
    () => () => {
      if (consumed.current) clearPendingInvite();
    },
    [],
  );
  // 보이는 참여 화면만 조회한다 (가입 화면 밑에 깔린 이 화면은 하지 않는다).
  useFocusEffect(
    useCallback(() => {
      if (!user || !linkCode || !onLinkServer) return;
      consumed.current = true;
      void lookup(linkCode);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, linkCode, onLinkServer]),
  );

  if (!loading && !user) {
    return <SignInFirst code={linkCode} busy={busy} error={error} />;
  }

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
      clearPendingInvite();
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

/** 로그인하지 않은 채 초대 링크로 들어왔을 때. 코드를 들고 로그인·가입으로 보낸다. */
function SignInFirst({ code, busy, error }: { code: string | null; busy: boolean; error: string | null }) {
  const { colors } = useTheme();
  const { activeServer } = useAuth();
  const go = (href: '/login' | '/signup') => {
    if (code) setPendingInvite(code);
    if (href === '/login') router.replace(href);
    else router.push(href);
  };
  // 서버가 주는 웹 페이지면 설치한 앱으로 넘기는 링크도 준다.
  const appLink =
    code && !IS_CLIENT_BUILD && Platform.OS === 'web' ? appLinkFor(window.location.origin, code) : null;

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>초대받은 저장소에 참여</Title>
        <Subtitle>
          {code ? `초대 코드 ${formatInviteCode(code)} 로 참여하려면` : '초대 코드로 참여하려면'} 이 서버에 로그인하거나
          가입하세요. 계정은 서버마다 따로입니다.
        </Subtitle>
      </View>
      {error ? <ErrorNotice message={error} /> : null}
      <Card style={{ gap: spacing.md }}>
        {activeServer ? <Caption>서버: {serverUrl(activeServer) || '이 사이트'}</Caption> : null}
        <Button label="로그인" icon="log-in-outline" onPress={() => go('/login')} loading={busy} full />
        <Button label="가입하기" icon="person-add-outline" variant="secondary" onPress={() => go('/signup')} disabled={busy} full />
      </Card>
      {appLink ? (
        <Card style={{ gap: spacing.xs }}>
          <Body muted>ListUp 앱을 설치했다면 앱에서 열 수 있습니다.</Body>
          <Link href={appLink} style={{ color: colors.accent, fontWeight: '600' }}>
            설치한 앱에서 열기
          </Link>
        </Card>
      ) : null}
    </Screen>
  );
}
