import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  ErrorNotice,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { TelemetryItemList, TelemetryNotRecordedList } from '../src/components/TelemetryConsent';
import { desktopBridge } from '../src/lib/desktop';
import { confirmAction, notifyError, notifySuccess } from '../src/lib/dialogs';
import {
  currentTelemetrySnapshot,
  debugCrash,
  debugRaiseErrors,
  deleteTelemetryRecords,
  exportTelemetry,
  openTelemetryFolder,
  setTelemetryConsent,
  telemetryInfo,
  useTelemetryConsent,
} from '../src/lib/telemetry';
import { spacing } from '../src/theme';

type Info = Awaited<ReturnType<typeof telemetryInfo>>;
type Snapshot = ReturnType<typeof currentTelemetrySnapshot>;

const errorMessage = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** 기록을 친구(과제 모으는 사람)에게 보내는 법 — 플랫폼마다 내보내기가 하는 일이 다르다. */
function sendGuide(): string {
  if (desktopBridge()) return '「기록 내보내기」로 저장한 csv 파일을 메신저나 메일에 첨부해 보내세요.';
  if (Platform.OS === 'android') return '「기록 내보내기」를 누르면 공유 창이 뜹니다. 거기서 메신저나 메일을 고르세요.';
  return '「기록 내보내기」를 누르면 csv 파일을 내려받습니다. 내려받은 파일을 메신저나 메일에 첨부해 보내세요.';
}

/**
 * 실행 기록 — 학교 데이터 분석 과제용 성능·안정성 기록을 켜고 끄고, 내보내고, 지운다.
 * 기록은 이 기기에만 남고, 내보내기를 눌러야만 밖으로 나간다. 로그인 전후 모두 들어온다.
 */
export default function TelemetryScreen() {
  const { consent, ready } = useTelemetryConsent();
  const granted = consent === 'granted';
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'export' | 'delete' | 'folder' | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInfo(await telemetryInfo());
      setInfoError(null);
    } catch (err) {
      setInfoError(errorMessage(err, '기록 정보를 읽지 못했습니다.'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // 켜고 끄면 쌓인 줄 수가 바뀔 수 있다(끄면 이번 실행 기록을 버린다).
  useEffect(() => {
    if (ready) void refresh();
  }, [consent, ready, refresh]);

  const toggle = async () => {
    if (busy) return;
    setBusy('toggle');
    try {
      await setTelemetryConsent(!granted);
      notifySuccess(granted ? '실행 기록을 껐습니다.' : '실행 기록을 켰습니다.');
    } catch (err) {
      notifyError('설정을 바꾸지 못했습니다.', errorMessage(err, ''));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const doExport = async () => {
    if (busy) return;
    setBusy('export');
    try {
      const result = await exportTelemetry();
      if (result) notifySuccess(result);
    } catch (err) {
      notifyError('기록을 내보내지 못했습니다.', errorMessage(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    if (busy) return;
    setBusy('folder');
    try {
      await openTelemetryFolder();
    } catch (err) {
      notifyError('폴더를 열지 못했습니다.', errorMessage(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = await confirmAction({
      title: '쌓인 실행 기록을 모두 지울까요?',
      message: '이 기기에 남은 기록 파일을 지웁니다. 되돌릴 수 없습니다. 기록 켜기·끄기 설정은 그대로입니다.',
      confirmLabel: '삭제',
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await deleteTelemetryRecords();
      notifySuccess('실행 기록을 지웠습니다.');
    } catch (err) {
      notifyError('기록을 지우지 못했습니다.', errorMessage(err, ''));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const statusBadge = !ready ? (
    <Badge label="확인 중" />
  ) : granted ? (
    <Badge label="기록 중" tone="success" icon="radio-button-on" />
  ) : consent === 'denied' ? (
    <Badge label="꺼짐" />
  ) : (
    <Badge label="아직 고르지 않음" tone="warning" />
  );

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>실행 기록</Title>
        <Subtitle>
          학교 데이터 분석 과제용으로, 앱을 한 번 실행할 때마다 성능·안정성 기록 한 줄을 이 기기에만 남깁니다.
          자동으로 보내지 않고, 직접 내보낼 때만 밖으로 나갑니다.
        </Subtitle>
      </View>

      <Card style={{ gap: spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }} wrap>
          <Body style={{ fontWeight: '600' }}>기록하기</Body>
          {statusBadge}
        </Row>
        <Caption>
          {granted
            ? '이번 실행부터 기록하고 있습니다. 끄면 바로 멈추고 이번 실행 기록은 버립니다.'
            : '꺼져 있습니다. 켜면 바로 기록을 시작합니다. 꺼 두어도 앱은 그대로 쓸 수 있습니다.'}
        </Caption>
        <Button
          label={granted ? '기록 끄기' : '기록 켜기'}
          variant={granted ? 'secondary' : 'primary'}
          icon={granted ? 'pause' : 'play'}
          onPress={() => void toggle()}
          loading={busy === 'toggle'}
          disabled={!ready || (busy !== null && busy !== 'toggle')}
        />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Body style={{ fontWeight: '600' }}>쌓인 기록</Body>
        {infoError ? <ErrorNotice message={infoError} onRetry={() => void refresh()} /> : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <Caption>기록 수</Caption>
          <Caption>{info ? `${info.rows}줄` : '…'}</Caption>
        </Row>
        <Row style={{ justifyContent: 'space-between' }} gap={spacing.md}>
          <Caption>저장 위치</Caption>
          <Caption style={{ flexShrink: 1, textAlign: 'right' }}>{info ? info.location : '…'}</Caption>
        </Row>
        <Row wrap>
          <Button
            label="기록 내보내기"
            icon="share-outline"
            compact
            onPress={() => void doExport()}
            loading={busy === 'export'}
            disabled={busy !== null && busy !== 'export'}
          />
          {info?.canOpenFolder ? (
            <Button
              label="폴더 열기"
              variant="secondary"
              icon="folder-open-outline"
              compact
              onPress={() => void openFolder()}
              loading={busy === 'folder'}
              disabled={busy !== null && busy !== 'folder'}
            />
          ) : null}
          <Button
            label="기록 삭제"
            variant="danger"
            icon="trash-outline"
            compact
            onPress={() => void remove()}
            loading={busy === 'delete'}
            disabled={busy !== null && busy !== 'delete'}
          />
        </Row>
        <View style={{ gap: spacing.xs }}>
          <Body style={{ fontWeight: '600' }}>친구에게 보내는 법</Body>
          <Caption style={{ lineHeight: 18 }}>{sendGuide()}</Caption>
        </View>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Body style={{ fontWeight: '600' }}>기록하는 것</Body>
        <TelemetryItemList />
        <Divider />
        <Body style={{ fontWeight: '600' }}>기록하지 않는 것</Body>
        <TelemetryNotRecordedList />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <Button
          label={debugOpen ? '디버그 옵션 숨기기' : '디버그 옵션 보기'}
          variant="ghost"
          icon={debugOpen ? 'chevron-up' : 'chevron-down'}
          compact
          onPress={() => setDebugOpen((prev) => !prev)}
        />
        {debugOpen ? <DebugPanel granted={granted} /> : null}
      </Card>
    </Screen>
  );
}

/** 디버그 (테스트용) — 기록이 제대로 잡히는지 확인한다. 기록을 켰을 때만 쓸 수 있다. */
function DebugPanel({ granted }: { granted: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => currentTelemetrySnapshot());

  // 펼쳐 둔 동안, 이 화면이 보일 때만 1초마다 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      setSnapshot(currentTelemetrySnapshot());
      const timer = setInterval(() => setSnapshot(currentTelemetrySnapshot()), 1000);
      return () => clearInterval(timer);
    }, []),
  );

  const crash = async () => {
    const ok = await confirmAction({
      title: '앱을 강제로 끝낼까요?',
      message: '정리 없이 끝내 비정상 종료를 흉내 냅니다. 다음 실행 기록에 비정상 종료로 남습니다.',
      confirmLabel: '강제 종료',
      destructive: true,
    });
    if (ok) debugCrash();
  };

  const fmt = (value: number | null, unit = '') => (value === null ? '—' : `${Math.round(value * 10) / 10}${unit}`);

  return (
    <View style={{ gap: spacing.md }}>
      <Body style={{ fontWeight: '600' }}>디버그 (테스트용)</Body>
      {snapshot ? (
        <View style={{ gap: spacing.xs }}>
          <SnapshotRow label="평균 FPS" value={fmt(snapshot.avgFps)} />
          <SnapshotRow label="최저 FPS (1초)" value={fmt(snapshot.minFps)} />
          <SnapshotRow label="최대 메모리" value={fmt(snapshot.maxRamMb, ' MB')} />
          <SnapshotRow label="실행 시간" value={fmt(snapshot.durationMin, '분')} />
          <SnapshotRow label="에러 수" value={String(snapshot.errorCount)} />
        </View>
      ) : (
        <Caption>지금은 기록하고 있지 않습니다.</Caption>
      )}
      <Row wrap>
        <Button
          label="테스트 에러 3개 일으키기"
          variant="secondary"
          icon="bug-outline"
          compact
          onPress={() => {
            debugRaiseErrors();
            notifySuccess('테스트 에러 3개를 일으켰습니다.');
          }}
          disabled={!granted}
        />
        <Button
          label="강제 종료 흉내"
          variant="danger"
          icon="power-outline"
          compact
          onPress={() => void crash()}
          disabled={!granted}
        />
      </Row>
      {!granted ? <Caption>기록을 켜야 쓸 수 있습니다.</Caption> : null}
      <Caption style={{ lineHeight: 18 }}>
        여기서 만든 기록은 테스트용입니다. 실제 기록을 보내기 전에 「기록 삭제」로 지우세요.
      </Caption>
    </View>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Caption>{label}</Caption>
      <Caption>{value}</Caption>
    </Row>
  );
}
