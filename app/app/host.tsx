import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Switch, View } from 'react-native';
import type { HostStatus, HostTools, HostTunnelMode } from '@listup/shared';
import { HOST_STATE_BADGE, useEnterOwnServer } from '../src/components/HostCard';
import {
  Badge,
  Body,
  Button,
  Caption,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  IconButton,
  Input,
  Loading,
  Row,
  Screen,
  Subtitle,
  Title,
} from '../src/components/ui';
import { notify } from '../src/lib/dialogs';
import { desktopBridge, desktopErrorMessage, useHostStatus } from '../src/lib/desktop';
import { fontSize, monoFont, spacing, useTheme } from '../src/theme';

/** PC 앱 — 이 PC 에서 연 서버를 켜고 끄고, 공개 방식·계정·데이터를 다룬다. */
export default function HostScreen() {
  const host = desktopBridge()?.host;
  const status = useHostStatus();

  if (!host) {
    return (
      <Screen>
        <EmptyState
          icon="desktop-outline"
          title="PC 앱에서만 열 수 있습니다"
          description="이 PC 를 서버로 쓰려면 ListUp PC 앱을 설치하세요. 명령줄로 여는 방법은 README 에 있습니다."
        />
      </Screen>
    );
  }
  if (!status) return <Loading />;
  return <HostPanel status={status} />;
}

function HostPanel({ status }: { status: HostStatus }) {
  const host = desktopBridge()!.host;
  const enterOwnServer = useEnterOwnServer();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running = status.state === 'running';
  const stopped = status.state === 'stopped' || status.state === 'error';
  const badge = HOST_STATE_BADGE[status.state];

  /** 버튼 하나의 일을 한다 — 도는 동안 그 버튼만 돌고, 실패하면 위에 이유를 보인다. */
  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(desktopErrorMessage(err, '하지 못했습니다.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>이 PC 서버</Title>
        <Subtitle>
          이 PC 를 ListUp 서버로 씁니다. 켜 두는 동안 초대한 사람들이 들어올 수 있고, 창을 닫아도 트레이에서
          계속 돕니다. 계정과 파일은 이 PC 의 데이터 폴더에 쌓입니다.
        </Subtitle>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <Card style={{ gap: spacing.md }}>
        <Row gap={spacing.sm}>
          <Body style={{ fontWeight: '600' }}>서버</Body>
          <Badge label={badge.label} tone={badge.tone} />
        </Row>
        {status.error ? <ErrorNotice message={status.error} /> : null}
        <Row gap={spacing.sm} wrap>
          {running || status.state === 'stopping' ? (
            <>
              <Button
                label="들어가기"
                icon="log-in-outline"
                disabled={!running}
                loading={busy === 'enter'}
                onPress={() => void act('enter', () => enterOwnServer(status))}
              />
              <Button
                label="서버 끄기"
                variant="danger"
                icon="power"
                loading={busy === 'stop' || status.state === 'stopping'}
                onPress={() => void act('stop', () => host.stop())}
              />
            </>
          ) : (
            <Button
              label="서버 켜기"
              icon="power"
              loading={busy === 'start' || status.state === 'starting'}
              onPress={() => void act('start', () => host.start())}
            />
          )}
        </Row>
      </Card>

      <AddressCard status={status} />
      <TunnelCard status={status} act={act} busy={busy} />
      <ResetCodeCard running={running} />
      <StartupCard status={status} stopped={stopped} act={act} />
      <DataCard status={status} stopped={stopped} act={act} busy={busy} />
      <LogCard running={running} />
    </Screen>
  );
}

type Act = (name: string, work: () => Promise<unknown>) => Promise<void>;

function CopyLine({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Caption>{label}</Caption>
        <Body numberOfLines={1} style={{ fontFamily: monoFont, color: colors.text }}>
          {value}
        </Body>
      </View>
      <IconButton
        icon="copy-outline"
        label={`${label} 복사`}
        onPress={() => {
          void Clipboard.setStringAsync(value).then(() => notify('주소를 복사했습니다.'));
        }}
      />
    </Row>
  );
}

function AddressCard({ status }: { status: HostStatus }) {
  if (status.state !== 'running') return null;
  const publicUrl = status.tunnel.state === 'on' ? status.tunnel.url : null;
  return (
    <Card style={{ gap: spacing.md }}>
      <Body style={{ fontWeight: '600' }}>들어오는 주소</Body>
      {publicUrl ? <CopyLine label="밖에서 (공개 주소)" value={publicUrl} /> : null}
      {status.lanUrls.map((url, index) => (
        <CopyLine key={url} label={index === 0 ? '같은 공유기에서' : '같은 공유기에서 (다른 네트워크 어댑터)'} value={url} />
      ))}
      <CopyLine label="이 PC 에서" value={status.localUrl} />
      <Caption>
        초대 링크는 이 서버에 들어가 저장소의 초대 화면에서 만듭니다. 공개 주소가 켜져 있으면 링크에 그 주소가
        들어갑니다.
      </Caption>
    </Card>
  );
}

const TUNNEL_OPTIONS: { mode: HostTunnelMode; title: string; description: string }[] = [
  { mode: 'off', title: '공개하지 않음', description: '이 PC 와 같은 공유기에서만 들어옵니다.' },
  {
    mode: 'tailscale',
    title: 'Tailscale Funnel',
    description: '고정 주소(*.ts.net). Tailscale 계정만 있으면 무료입니다. 처음 한 번 Funnel 을 허용해야 합니다.',
  },
  {
    mode: 'quick',
    title: 'Cloudflare 빠른 터널',
    description: '계정 없이 바로 됩니다. 대신 서버를 켤 때마다 주소가 바뀌어 초대 링크를 다시 보내야 합니다.',
  },
];

function toolNote(mode: HostTunnelMode, tools: HostTools | null): string | null {
  if (!tools) return null;
  if (mode === 'tailscale') {
    if (!tools.tailscale.installed) return 'Tailscale 이 설치돼 있지 않습니다 (tailscale.com/download).';
    if (!tools.tailscale.hostname) return 'Tailscale 에 로그인돼 있지 않습니다.';
    return `https://${tools.tailscale.hostname}`;
  }
  if (mode === 'quick' && !tools.cloudflared.installed) {
    return 'cloudflared 가 설치돼 있지 않습니다 (winget install Cloudflare.cloudflared).';
  }
  return null;
}

function TunnelCard({ status, act, busy }: { status: HostStatus; act: Act; busy: string | null }) {
  const host = desktopBridge()!.host;
  const { colors } = useTheme();
  const [tools, setTools] = useState<HostTools | null>(null);

  // 설치·로그인은 앱 밖에서 하므로 화면에 돌아올 때마다 다시 본다.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void host.inspectTools().then((found) => {
        if (!cancelled) setTools(found);
      });
      return () => {
        cancelled = true;
      };
    }, [host]),
  );

  const tunnel = status.tunnel;
  return (
    <Card style={{ gap: spacing.md }}>
      <Body style={{ fontWeight: '600' }}>밖에서 들어오기</Body>
      {TUNNEL_OPTIONS.map((option) => {
        const chosen = tunnel.mode === option.mode;
        const note = toolNote(option.mode, tools);
        return (
          <Pressable
            key={option.mode}
            onPress={() => void act(`tunnel-${option.mode}`, () => host.update({ tunnel: option.mode }))}
            disabled={busy !== null}
            accessibilityRole="radio"
            aria-checked={chosen}
            accessibilityLabel={option.title}
            style={({ pressed }) => ({
              flexDirection: 'row',
              gap: spacing.md,
              alignItems: 'flex-start',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View
              style={{
                width: 18,
                height: 18,
                marginTop: 2,
                borderRadius: 9,
                borderWidth: 2,
                borderColor: chosen ? colors.accent : colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {chosen ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Body>{option.title}</Body>
              <Caption>{option.description}</Caption>
              {note ? <Caption style={{ fontFamily: monoFont }}>{note}</Caption> : null}
            </View>
          </Pressable>
        );
      })}

      {tunnel.state === 'starting' ? <Caption>공개 주소를 여는 중…</Caption> : null}
      {tunnel.message ? (
        tunnel.state === 'error' ? (
          <ErrorNotice message={tunnel.message} />
        ) : (
          <Caption style={{ color: colors.textMuted }}>{tunnel.message}</Caption>
        )
      ) : null}
      {tunnel.actionUrl ? (
        <Button
          label="Tailscale 에서 허용하기"
          icon="open-outline"
          variant="secondary"
          onPress={() => void Linking.openURL(tunnel.actionUrl!)}
        />
      ) : null}
      {status.state !== 'running' ? <Caption>고른 방식은 서버를 켜면 열립니다.</Caption> : null}
      <Caption style={{ fontSize: fontSize.xs }}>
        이름 있는 Cloudflare 터널(자기 도메인)은 명령줄 서버(npm run serve)에서 씁니다.
      </Caption>
    </Card>
  );
}

function ResetCodeCard({ running }: { running: boolean }) {
  const host = desktopBridge()!.host;
  const [email, setEmail] = useState('');
  const [issued, setIssued] = useState<{ email: string; code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const issue = async () => {
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const result = await host.issueResetCode(email.trim());
      if (!result) setError(`이 서버에 ${email.trim()} 계정이 없습니다.`);
      else setIssued({ email: email.trim(), ...result });
    } catch (err) {
      setError(desktopErrorMessage(err, '발급하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const until = issued
    ? new Date(issued.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <Card style={{ gap: spacing.md }}>
      <Body style={{ fontWeight: '600' }}>비밀번호를 잊은 사람</Body>
      <Caption>
        재설정 코드를 발급해 본인에게 전해 주세요. 앱 로그인 화면의 "비밀번호를 잊었나요?" 에서 새 비밀번호를
        정합니다. 코드는 30분 동안 한 번 쓸 수 있고, 새 비밀번호를 정하면 그 계정의 다른 기기 로그인은 끊깁니다.
      </Caption>
      {error ? <ErrorNotice message={error} /> : null}
      <Field label="이메일">
        <Input
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="그사람@example.com"
          onSubmitEditing={() => void issue()}
        />
      </Field>
      <Button
        label="재설정 코드 발급"
        icon="key-outline"
        variant="secondary"
        loading={busy}
        disabled={!running || !email.trim()}
        onPress={() => void issue()}
      />
      {!running ? <Caption>서버가 켜져 있을 때 발급할 수 있습니다.</Caption> : null}
      {issued ? (
        <CopyLine label={`${issued.email} · ${until} 까지`} value={issued.code} />
      ) : null}
    </Card>
  );
}

function SwitchRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      aria-checked={value}
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Body>{label}</Body>
        <Caption>{description}</Caption>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.border }} aria-hidden />
    </Pressable>
  );
}

function StartupCard({ status, stopped, act }: { status: HostStatus; stopped: boolean; act: Act }) {
  const host = desktopBridge()!.host;
  const [port, setPort] = useState(String(status.port));
  useEffect(() => setPort(String(status.port)), [status.port]);
  const portNumber = Number(port);
  const portValid = /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;

  return (
    <Card style={{ gap: spacing.lg }}>
      <Body style={{ fontWeight: '600' }}>실행</Body>
      <SwitchRow
        label="앱을 열 때 서버도 켜기"
        description="ListUp 을 켜면 서버가 함께 켜집니다."
        value={status.autoStart}
        onChange={(next) => void act('auto-start', () => host.update({ autoStart: next }))}
      />
      <SwitchRow
        label="Windows 에 로그인하면 켜기"
        description="창 없이 트레이에서 켜지고 서버도 켭니다. PC 를 다시 켜도 서버가 이어집니다."
        value={status.openAtLogin}
        onChange={(next) => void act('open-at-login', () => host.update({ openAtLogin: next }))}
      />
      <Field label="포트" hint={stopped ? '다른 프로그램이 4000 을 쓰고 있으면 바꾸세요.' : '서버를 끈 뒤에 바꿀 수 있습니다.'}>
        <Row gap={spacing.sm}>
          <Input
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
            editable={stopped}
            style={{ width: 120 }}
          />
          <Button
            label="저장"
            variant="secondary"
            compact
            disabled={!stopped || !portValid || portNumber === status.port}
            onPress={() => void act('port', () => host.update({ port: portNumber }))}
          />
        </Row>
      </Field>
    </Card>
  );
}

function DataCard({ status, stopped, act, busy }: { status: HostStatus; stopped: boolean; act: Act; busy: string | null }) {
  const host = desktopBridge()!.host;
  const { colors } = useTheme();
  return (
    <Card style={{ gap: spacing.md }}>
      <Body style={{ fontWeight: '600' }}>데이터</Body>
      <View style={{ gap: 2 }}>
        <Caption>데이터 폴더 — DB·올린 파일·서명 키</Caption>
        <Body style={{ fontFamily: monoFont, color: colors.text }}>
          {status.dataDir}
        </Body>
      </View>
      <Row gap={spacing.sm} wrap>
        <Button label="폴더 열기" variant="secondary" icon="folder-open-outline" compact onPress={() => void host.openDataFolder()} />
        <Button
          label="다른 폴더 쓰기"
          variant="secondary"
          icon="swap-horizontal"
          compact
          disabled={!stopped}
          onPress={() => void act('data-dir', () => host.chooseDataFolder())}
        />
        <Button
          label="백업"
          variant="secondary"
          icon="archive-outline"
          compact
          loading={busy === 'backup'}
          onPress={() =>
            void act('backup', async () => {
              const dir = await host.backup();
              if (dir) notify('백업했습니다.', `${dir}\n\nDB 사본과 blobs 폴더를 담았습니다. 같은 폴더에 다시 백업하면 새 파일만 더해집니다.`);
            })
          }
        />
      </Row>
      <Caption>
        명령줄 서버(npm run serve)로 쓰던 데이터가 있으면 서버를 끈 채 "다른 폴더 쓰기"로 그 폴더(server/data)를
        고르세요. 서명 키도 그 폴더에 있어 로그인이 그대로 이어집니다. 두 서버를 같은 폴더로 동시에 켜지는 마세요.
      </Caption>
    </Card>
  );
}

function LogCard({ running }: { running: boolean }) {
  const host = desktopBridge()!.host;
  const { colors } = useTheme();
  const [lines, setLines] = useState<string[]>([]);

  // 켜져 있는 동안 몇 초마다 새로 읽는다.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const load = () =>
        void host.logs().then((next) => {
          if (!cancelled) setLines(next.slice(-40));
        });
      load();
      const timer = running ? setInterval(load, 3000) : null;
      return () => {
        cancelled = true;
        if (timer) clearInterval(timer);
      };
    }, [host, running]),
  );

  if (lines.length === 0) return null;
  return (
    <Card style={{ gap: spacing.sm }}>
      <Body style={{ fontWeight: '600' }}>최근 로그</Body>
      <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 8, padding: spacing.md }}>
        <Caption style={{ fontFamily: monoFont, color: colors.textMuted, fontSize: fontSize.xs }}>
          {lines.join('\n')}
        </Caption>
      </View>
    </Card>
  );
}
