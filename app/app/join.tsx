import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  INVITE_CODE_LENGTH,
  ROLE_LABEL,
  formatInviteCode,
  parseInviteCode,
  type InvitePreview,
} from '@listup/shared';
import {
  Body,
  Button,
  Caption,
  Card,
  ErrorNotice,
  Field,
  Input,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { ApiError, IS_CLIENT_BUILD, api } from '../src/api/client';
import { confirmAction } from '../src/lib/dialogs';
import {
  appLinkFor,
  clearPendingInvite,
  clearPendingInviteSoon,
  isUnusableInviteStatus,
  keepPendingInvite,
  openJoinedRepo,
  setPendingInvite,
  shouldAutoJoin,
} from '../src/lib/invite-link';
import { InviteSummary, usePendingInvitePreview } from '../src/components/InviteSummary';
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

  const currentUrl = activeServer ? serverUrl(activeServer) : null;
  // 앱 링크가 가리키는 서버. 주소가 올바르지 않으면 무시하고 지금 서버로 본다.
  const linkTarget = params.server ? normalizeServerUrl(params.server) : null;
  // 링크가 가리키는 서버가 지금 서버일 때만 로그인 뒤 코드를 조회한다. 아니면 그 서버로 옮겨 간다.
  // 서버가 주는 웹에서는 지금 주소가 곧 서버다.
  const onLinkServer =
    !linkTarget ||
    linkTarget === currentUrl ||
    (!IS_CLIENT_BUILD && Platform.OS === 'web' && linkTarget === window.location.origin);

  // 앱 링크로 다른 서버의 초대를 받았다 — 그 서버로 들어간 뒤 참여를 잇는다. 처음 한 번은 저절로, 취소하거나
  // 연결 확인이 실패하면 「그 서버로 들어가기」로 다시 한다.
  const enterLinkServer = useCallback(async () => {
    if (!linkCode || !linkTarget || onLinkServer) return;
    const target = linkTarget;
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
    setError(null);
    try {
      const check = existing ? null : await checkServer(target);
      const problem = check ? describeCheck(check, target) : null;
      if (problem) {
        setError(problem);
        return;
      }
      // 초대 링크로 처음 더하는 서버는 서버 주인이 정한 이름으로 목록에 올린다.
      const label = check?.status === 'ok' ? check.name : null;
      const id = existing?.id ?? (await saveServer({ url: target, label }));
      // 들어가면 화면이 처음부터 다시 그려진다 — 코드를 그 서버와 함께 들고 가서 로그인 뒤 여기로 돌아온다.
      setPendingInvite(linkCode, target);
      await switchServer(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '서버에 들어가지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, [linkCode, linkTarget, onLinkServer, servers, saveServer, switchServer]);

  useEffect(() => {
    if (loading || handledServer.current || onLinkServer || !linkCode) return;
    handledServer.current = true;
    void enterLinkServer();
  }, [loading, onLinkServer, linkCode, enterLinkServer]);

  // 들고 온 초대 코드는 참여하거나, 코드를 조회까지 한 이 화면을 떠날 때 지운다. 조회하자마자 지우면
  // 로그인 직후 첫 화면이 한 번 더 그려질 때(보호 라우트) 초대를 잃고 저장소 목록으로 간다. 서버를
  // 옮기느라 조회 전에 이 화면이 사라지는 경우에는 지우지 않는다 — 옮긴 서버에서 로그인한 뒤 이어 간다.
  // 떠날 때는 다음 차례에 지운다 — 가입 직후 밑의 참여 화면이 새 참여 화면으로 바뀌는 사이에 지우지 않게.
  const consumed = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    keepPendingInvite();
    return () => {
      alive.current = false;
      if (consumed.current) clearPendingInviteSoon();
    };
  }, []);
  // 보이는 참여 화면만 조회한다 (가입 화면 밑에 깔린 이 화면은 하지 않는다).
  useFocusEffect(
    useCallback(() => {
      if (!user || !linkCode || !onLinkServer) return;
      consumed.current = true;
      void lookup(linkCode);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, linkCode, onLinkServer]),
  );

  if (!loading && linkCode && linkTarget && !onLinkServer) {
    return <OtherServerInvite target={linkTarget} busy={busy} error={error} onEnter={() => void enterLinkServer()} />;
  }
  if (!loading && !user) {
    return <SignInFirst code={linkCode} busy={busy} error={error} />;
  }

  async function lookup(code: string) {
    if (busy) return;
    const clean = parseInviteCode(code);
    if (!clean) {
      setError(`초대 코드는 ${INVITE_CODE_LENGTH}자입니다. 다시 확인해 주세요.`);
      return;
    }
    setBusy(true);
    setError(null);
    let found: InvitePreview | null = null;
    try {
      found = (await api.previewInvite(clean)).invite;
      setPreview(found);
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : '초대 코드를 확인하지 못했습니다.');
      // 못 쓰는 초대면 들고 있던 것도 버린다 — 안 그러면 첫 화면이 계속 여기로 되돌려 보낸다.
      if (err instanceof ApiError && isUnusableInviteStatus(err.status)) clearPendingInvite();
    } finally {
      setBusy(false);
    }
    // 로그인·가입 전에 이미 미리보기를 보고 들어왔다 — 같은 것을 다시 묻지 않고 바로 참여한다.
    // 조회하는 사이에 사라진 화면은 참여하지 않는다(그 자리에 새로 열린 참여 화면이 한다).
    if (found && alive.current && shouldAutoJoin(found.code)) {
      if (found.currentRole) {
        openJoinedRepo(found.repo.id);
      } else {
        await join(found);
      }
    }
  }

  async function join(target: InvitePreview | null = preview) {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.joinInvite(target.code);
      openJoinedRepo(result.repo.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '참여하지 못했습니다.');
      // 그사이 회수·만료·소진됐다 — 같은 실패를 되풀이할 「참여하기」를 내린다.
      if (err instanceof ApiError && isUnusableInviteStatus(err.status)) {
        setPreview(null);
        clearPendingInvite();
      }
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
          disabled={!normalized || busy}
          full
        />
        {/* 링크로 들어와 로그인·가입하면 이 화면이 스택의 첫 화면이라 뒤로 갈 곳이 없다. */}
        {router.canGoBack() ? null : (
          <Button label="내 저장소로" variant="ghost" onPress={() => router.replace('/repos')} disabled={busy} full />
        )}
      </Card>

      {preview ? (
        <Card style={{ gap: spacing.md }}>
          <InviteSummary preview={preview} />

          {preview.currentRole ? (
            <>
              <Body muted>
                이미 이 저장소에 {ROLE_LABEL[preview.currentRole]} 권한으로 참여하고 있습니다.
              </Body>
              <Button
                label="저장소 열기"
                onPress={() => openJoinedRepo(preview.repo.id)}
                full
              />
            </>
          ) : (
            <Button
              label={`${formatInviteCode(preview.code)} 코드로 참여하기`}
              onPress={() => void join()}
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
  const server = activeServer ? serverUrl(activeServer) : null;
  const { preview, error: previewError, unusable } = usePendingInvitePreview(code);
  // 코드를 먼저 들고 있어야 미리보기를 본 것이 로그인·가입 뒤 "바로 참여"로 이어진다. 못 쓰는 초대면 들지 않는다 —
  // 들면 로그인 화면이 "참여를 이어 갑니다" 라고 하고, 가입 뒤 같은 오류 화면으로 돌아온다.
  if (code && !unusable) setPendingInvite(code, server);
  useEffect(() => {
    if (unusable) clearPendingInvite();
  }, [unusable]);
  const go = (href: '/login' | '/signup') => {
    if (code && !unusable) setPendingInvite(code, server);
    // 로그인과 같이 replace — push 로 가입 화면을 얹으면 이 화면이 밑에 남아, 참여 뒤 뒤로 가기가 여기로 온다.
    router.replace(href);
  };
  // 서버가 주는 웹 페이지면 설치한 앱으로 넘기는 링크도 준다.
  const appLink =
    code && !IS_CLIENT_BUILD && Platform.OS === 'web' ? appLinkFor(window.location.origin, code) : null;

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>초대받은 저장소에 참여</Title>
        <Subtitle>
          {unusable
            ? '이 초대는 쓸 수 없습니다. 보낸 사람에게 새 링크를 받아 주세요. 계정은 그대로 만들 수 있습니다.'
            : preview
            ? '아래 저장소에 초대받았습니다. 이 서버에 로그인하거나 가입하면 바로 참여합니다. 계정은 서버마다 따로입니다.'
            : `${code ? `초대 코드 ${formatInviteCode(code)} 로 참여하려면` : '초대 코드로 참여하려면'} 이 서버에 로그인하거나 가입하세요. 계정은 서버마다 따로입니다.`}
        </Subtitle>
      </View>
      {error ? <ErrorNotice message={error} /> : null}
      {previewError ? <ErrorNotice message={previewError} /> : null}
      {preview ? (
        <Card style={{ gap: spacing.md }}>
          <InviteSummary preview={preview} />
        </Card>
      ) : null}
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

/** 앱 링크가 다른 서버의 초대일 때 — 그 서버로 들어가야 참여할 수 있다. 취소하거나 연결이 안 되면 여기서 다시 한다. */
function OtherServerInvite({
  target,
  busy,
  error,
  onEnter,
}: {
  target: string;
  busy: boolean;
  error: string | null;
  onEnter: () => void;
}) {
  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>다른 서버의 초대</Title>
        <Subtitle>이 초대는 {target} 서버의 것입니다. 그 서버로 들어가야 참여할 수 있습니다.</Subtitle>
      </View>
      {error ? <ErrorNotice message={error} /> : null}
      <Card style={{ gap: spacing.md }}>
        <Button label="그 서버로 들어가기" icon="log-in-outline" onPress={onEnter} loading={busy} full />
        <Button label="처음 화면으로" variant="ghost" onPress={() => router.replace('/')} disabled={busy} full />
      </Card>
    </Screen>
  );
}
