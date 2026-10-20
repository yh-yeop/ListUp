import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  APP_VERSION,
  SOURCE_URL,
  checkUpdate,
  clientKind,
  openReleasePage,
  updateChecksEnabled,
  type UpdateStatus,
} from '../lib/updates';
import { fontSize, spacing, useTheme } from '../theme';
import { Button, Caption, Row } from './ui';

/**
 * 이 앱의 버전과 업데이트 상태. 서버 목록(로그인 전에도 보이는 첫 화면)과 내 정보에 둔다.
 * 설치형 클라이언트(PC 앱·안드로이드)만 GitHub 최신 릴리즈와 견준다 — 서버가 주는 웹은 늘 서버와 같은 버전이다.
 *
 * 소스 코드 링크는 AGPL-3.0 §13 — 네트워크로 이 프로그램을 쓰는 사람에게 소스를 받을 길을 알려야 한다.
 */
export function AppVersion() {
  const { colors } = useTheme();
  const checks = updateChecksEnabled();
  const [result, setResult] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /** 사용자가 눌러서 확인했는지 — 그때만 "최신입니다"·"확인하지 못했습니다"를 보인다. */
  const [asked, setAsked] = useState(false);

  // 기억해 둔 결과로 먼저 보여 준다(오래됐으면 GitHub 에 한 번 묻는다).
  useEffect(() => {
    if (!checks) return;
    let cancelled = false;
    void checkUpdate().then((value) => {
      if (!cancelled) setResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, [checks]);

  const checkNow = async () => {
    setChecking(true);
    try {
      setResult(await checkUpdate({ force: true }));
      setAsked(true);
    } finally {
      setChecking(false);
    }
  };

  const update = result?.status === 'update' ? result.latest : null;

  return (
    <View style={{ gap: spacing.sm }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <Caption>
          ListUp {clientKind()} v{APP_VERSION} · AGPL-3.0
        </Caption>
        <Link href={SOURCE_URL} style={{ color: colors.accent, fontSize: fontSize.sm }} accessibilityLabel="소스 코드 보기">
          소스 코드
        </Link>
      </Row>

      {update ? (
        <Button
          label={`새 버전 v${update.version} 받기`}
          icon="download-outline"
          onPress={() => void openReleasePage(update.url)}
          full
        />
      ) : null}
      {update?.asset ? <Caption>받을 파일: {update.asset.name}</Caption> : null}

      {checks && !update ? (
        <Row gap={spacing.sm} wrap>
          <Button
            label="업데이트 확인"
            icon="refresh"
            variant="ghost"
            compact
            loading={checking}
            onPress={() => void checkNow()}
          />
          {asked && result?.status === 'current' ? <Caption>최신 버전입니다.</Caption> : null}
          {asked && result?.status === 'unknown' ? (
            <Caption style={{ color: colors.danger }}>GitHub 에 닿지 못해 확인하지 못했습니다.</Caption>
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}
