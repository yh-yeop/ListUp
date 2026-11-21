import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Badge, Body, Button, Caption, Card, Row, Screen, Subtitle, Title } from '../src/components/ui';
import { addressFacts, troubleshootAdvice, type Advice } from '../src/lib/pure/troubleshoot';
import { openServerList } from '../src/lib/server-list';
import { useAuth } from '../src/state/auth';
import { checkServer, describeUrl, findServerTitle, serverUrl, type ServerCheck } from '../src/state/servers';
import { fontSize, radius, spacing, useTheme } from '../src/theme';

/** 웹이면 지금 페이지의 프로토콜 — https 페이지에서 http 서버를 부르면 브라우저가 막는다. 앱은 null. */
function pageProtocol(): string | null {
  if (Platform.OS !== 'web' || typeof location === 'undefined') return null;
  return location.protocol;
}

/**
 * 연결 문제 해결 — 서버에 닿지 않을 때 이유를 다시 확인하고, 무엇을 차례로 볼지 알린다.
 * `?url=` 로 서버 목록의 특정 서버를, 없으면 지금 서버를 본다. 로그인 전후 모두 열린다.
 */
export default function TroubleshootScreen() {
  const { activeServer, servers } = useAuth();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ url?: string }>();
  const url = typeof params.url === 'string' && params.url ? params.url : activeServer ? serverUrl(activeServer) : null;
  const title = url !== null ? findServerTitle(servers, url) : null;
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const run = useCallback(async () => {
    if (url === null) return;
    setChecking(true);
    try {
      setCheck(await checkServer(url));
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  }, [url]);

  useEffect(() => {
    void run();
  }, [run]);

  let advice: Advice | null = null;
  if (check && url !== null) {
    advice = troubleshootAdvice(
      {
        status: check.status,
        reason: check.status === 'unreachable' ? check.reason : undefined,
        httpStatus: check.status === 'unreachable' ? check.httpStatus : undefined,
        version: check.status !== 'unreachable' ? check.version : null,
      },
      addressFacts(url, pageProtocol()),
    );
  }

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>연결 문제 해결</Title>
        <Subtitle>서버에 다시 닿아 보고, 닿지 않으면 무엇을 확인할지 가능성 높은 것부터 알려 드립니다.</Subtitle>
      </View>

      {url === null ? (
        <Card style={{ gap: spacing.md }}>
          <Body>아직 고른 서버가 없습니다. 서버 목록에서 서버를 추가하거나 고르세요.</Body>
          <Button label="서버 목록 열기" icon="server-outline" onPress={openServerList} />
        </Card>
      ) : (
        <Card style={{ gap: spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }} gap={spacing.sm}>
            <View style={{ flex: 1, gap: 2 }}>
              <Body style={{ fontWeight: '600' }} numberOfLines={1}>
                {title ?? describeUrl(url)}
              </Body>
              <Caption numberOfLines={1}>{describeUrl(url)}</Caption>
            </View>
            {check ? (
              <Badge
                label={check.status === 'ok' ? '연결됨' : check.status === 'unreachable' ? '닿지 않음' : '버전 다름'}
                tone={check.status === 'ok' ? 'success' : check.status === 'unreachable' ? 'warning' : 'danger'}
              />
            ) : null}
          </Row>

          {advice ? (
            <Body style={{ fontWeight: '600', color: check?.status === 'ok' ? colors.success : colors.text }}>
              {advice.summary}
            </Body>
          ) : (
            <Caption>확인하는 중…</Caption>
          )}

          <Row gap={spacing.sm} wrap>
            <Button label="다시 확인" icon="refresh" variant="secondary" onPress={() => void run()} loading={checking} />
            <Button label="서버 목록 열기" icon="server-outline" variant="ghost" onPress={openServerList} />
          </Row>
          {checkedAt ? <Caption>마지막 확인: {new Date(checkedAt).toLocaleTimeString('ko-KR')}</Caption> : null}
        </Card>
      )}

      {advice && advice.steps.length > 0 ? (
        <Card style={{ gap: spacing.md }}>
          <Body heading style={{ fontWeight: '600' }}>
            이것부터 확인하세요
          </Body>
          {advice.steps.map((step, index) => (
            <Row key={step.title} gap={spacing.md} style={{ alignItems: 'flex-start' }}>
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: radius.pill,
                  backgroundColor: colors.accentSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Body style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: '700' }}>{index + 1}</Body>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Body style={{ fontWeight: '600' }}>{step.title}</Body>
                <Caption>{step.detail}</Caption>
              </View>
            </Row>
          ))}
        </Card>
      ) : null}

      <Card style={{ gap: spacing.sm }}>
        <Row gap={spacing.sm}>
          <Ionicons name="chatbubbles-outline" size={18} color={colors.textMuted} />
          <Body heading style={{ fontWeight: '600', flex: 1 }}>
            그래도 안 되면
          </Body>
        </Row>
        <Caption>
          서버를 돌리는 사람에게 이 화면의 요약과 주소를 알려 주세요. 운영자는 서버 PC 에서 ListUp 이 켜져 있는지, 공개
          방식(터널·Tailscale)의 주소가 바뀌지 않았는지 볼 수 있습니다. 파일과 계정은 서버에 그대로 있으니, 다시 닿으면 이어서 쓰면
          됩니다.
        </Caption>
      </Card>
    </Screen>
  );
}
