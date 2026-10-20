import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { DesktopUpdateState } from '@listup/shared';
import { apkInstallSupported } from '../lib/apk-update';
import { desktopBridge, useDesktopUpdate } from '../lib/desktop';
import {
  APP_VERSION,
  SOURCE_URL,
  checkUpdate,
  clientKind,
  installApkUpdate,
  openReleasePage,
  updateChecksEnabled,
  type LatestRelease,
  type UpdateStatus,
} from '../lib/updates';
import { fontSize, spacing, useTheme } from '../theme';
import { Button, Caption, Row } from './ui';

/**
 * 이 앱의 버전과 업데이트. 서버 목록(로그인 전에도 보이는 첫 화면)과 내 정보에 둔다.
 * - PC 앱(1.7 부터): 자동 업데이트 상태 — 받는 중 / 다시 시작해 설치
 * - 안드로이드: 새 버전을 받아 설치 화면까지
 * - 그 밖의 설치형 클라이언트: GitHub 최신 릴리즈와 견주고 릴리즈 페이지로
 * 서버가 주는 웹은 늘 서버와 같은 버전이라 확인하지 않는다.
 *
 * 소스 코드 링크는 AGPL-3.0 §13 — 네트워크로 이 프로그램을 쓰는 사람에게 소스를 받을 길을 알려야 한다.
 */
export function AppVersion() {
  const { colors } = useTheme();
  const desktopUpdate = useDesktopUpdate();

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
      {desktopUpdate ? <DesktopUpdatePanel state={desktopUpdate} /> : updateChecksEnabled() ? <ReleaseUpdatePanel /> : null}
    </View>
  );
}

/** PC 앱 자동 업데이트. */
function DesktopUpdatePanel({ state }: { state: DesktopUpdateState }) {
  const { colors } = useTheme();
  const updates = desktopBridge()?.updates;
  const [asked, setAsked] = useState(false);
  const [installing, setInstalling] = useState(false);
  if (!updates) return null;

  if (state.status === 'ready') {
    return (
      <View style={{ gap: spacing.xs }}>
        <Button
          label={`다시 시작해 v${state.version} 설치`}
          icon="refresh"
          loading={installing}
          onPress={() => {
            setInstalling(true);
            void updates.install().finally(() => setInstalling(false));
          }}
          full
        />
        <Caption>그냥 끝내도 끝낼 때 설치됩니다. 켜 둔 서버는 설치 뒤 다시 켜집니다.</Caption>
      </View>
    );
  }
  if (state.status === 'downloading') {
    return <Caption>새 버전 v{state.version} 을 받는 중… {state.percent ?? 0}%</Caption>;
  }
  return (
    <View style={{ gap: spacing.xs }}>
      <Row gap={spacing.sm} wrap>
        <Button
          label="업데이트 확인"
          icon="refresh"
          variant="ghost"
          compact
          loading={state.status === 'checking'}
          onPress={() => {
            setAsked(true);
            void updates.check();
          }}
        />
        {asked && state.status === 'none' ? <Caption>최신 버전입니다.</Caption> : null}
      </Row>
      {state.status === 'error' ? (
        <Row gap={spacing.sm} wrap>
          <Caption style={{ color: colors.danger }}>자동 업데이트에 실패했습니다: {state.error}</Caption>
          <Button label="릴리즈 페이지에서 받기" variant="ghost" compact onPress={() => void openReleasePage()} />
        </Row>
      ) : null}
    </View>
  );
}

/** GitHub 최신 릴리즈와 견준다 — 안드로이드는 앱 안에서 받아 설치, 그 밖에는 릴리즈 페이지로. */
function ReleaseUpdatePanel() {
  const { colors } = useTheme();
  const [result, setResult] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /** 사용자가 눌러서 확인했는지 — 그때만 "최신입니다"·"확인하지 못했습니다"를 보인다. */
  const [asked, setAsked] = useState(false);
  /** 안드로이드에서 받는 중이면 0~1. */
  const [downloading, setDownloading] = useState<number | null>(null);

  // 기억해 둔 결과로 먼저 보여 준다(오래됐으면 GitHub 에 한 번 묻는다).
  useEffect(() => {
    let cancelled = false;
    void checkUpdate().then((value) => {
      if (!cancelled) setResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkNow = async () => {
    setChecking(true);
    try {
      setResult(await checkUpdate({ force: true }));
      setAsked(true);
    } finally {
      setChecking(false);
    }
  };

  const install = async (latest: LatestRelease) => {
    setDownloading(0);
    try {
      await installApkUpdate(latest, setDownloading);
    } finally {
      setDownloading(null);
    }
  };

  const update = result?.status === 'update' ? result.latest : null;
  const inApp = apkInstallSupported && update?.asset;

  return (
    <View style={{ gap: spacing.sm }}>
      {update ? (
        <Button
          label={inApp ? `새 버전 v${update.version} 받아 설치` : `새 버전 v${update.version} 받기`}
          icon="download-outline"
          loading={downloading !== null}
          onPress={() => void (inApp ? install(update) : openReleasePage(update.url))}
          full
        />
      ) : null}
      {downloading !== null ? (
        <Caption>받는 중… {Math.floor(downloading * 100)}% — 다 받으면 설치 화면이 뜹니다.</Caption>
      ) : update?.asset ? (
        <Caption>받을 파일: {update.asset.name}</Caption>
      ) : null}

      {!update ? (
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
