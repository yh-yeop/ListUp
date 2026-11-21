import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ROLE_DESCRIPTION, ROLE_LABEL, type Role } from '@listup/shared';
import { Body, Caption, Card, Divider, Row, Screen, Subtitle, Title } from '../src/components/ui';
import { SHORTCUTS, shortcutsSupported } from '../src/lib/shortcuts';
import { useAuth } from '../src/state/auth';
import { fontSize, monoFont, radius, spacing, useTheme } from '../src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const ROLES: Role[] = ['viewer', 'editor', 'owner'];

/**
 * 도움말 — 처음 쓰는 사람이 서버·계정·저장소·역할·제안을 한곳에서 읽는다. 화면마다 흩어진 한 줄 안내를 모으고,
 * 자주 막히는 문제(비밀번호·아이디·연결)로 바로 가는 길을 둔다. 로그인 전후 모두 열린다.
 */
export default function HelpScreen() {
  const { user } = useAuth();

  return (
    <Screen>
      <View style={{ gap: spacing.sm }}>
        <Title>ListUp 사용법</Title>
        <Subtitle>
          ListUp 은 초대 코드로 들어오는 파일 공유 공간입니다. 누군가 돌리는 서버에 계정을 만들고, 저장소에 파일을 모아
          함께 씁니다.
        </Subtitle>
      </View>

      <Section icon="map-outline" title="처음 시작하는 순서">
        <Step n={1} title="서버 주소 받기">
          서버를 돌리는 사람에게 주소(또는 초대 링크)를 받아 서버 목록에 추가합니다. 초대 링크를 열었다면 이미 들어와 있습니다.
        </Step>
        <Step n={2} title="계정 만들기">
          그 서버에서 쓸 아이디와 비밀번호를 정합니다. 계정은 서버마다 따로라, 다른 서버에서는 새로 만듭니다.
        </Step>
        <Step n={3} title="저장소에 들어가기">
          받은 초대 코드로 참여하거나, 내 저장소를 만들고 다른 사람을 초대합니다.
        </Step>
        <Step n={4} title="파일 주고받기">
          권한에 따라 파일을 올리고, 내려받고, 바꿀 것을 제안합니다.
        </Step>
      </Section>

      <Section icon="book-outline" title="낱말 풀이">
        <Term name="서버">
          ListUp 이 돌아가는 컴퓨터입니다. 서버를 돌리는 사람(운영자)이 주소를 알려 줍니다. 앱은 여러 서버를 기억하고 골라
          들어갑니다.
        </Term>
        <Term name="계정">서버마다 따로입니다. 한 서버의 아이디·비밀번호는 다른 서버에서 쓰이지 않습니다.</Term>
        <Term name="저장소">파일을 모아 두는 공간입니다. 멤버만 볼 수 있고, 바뀐 기록이 남아 예전 시점으로 돌아가 볼 수 있습니다.</Term>
        <Term name="초대 코드">저장소 소유자가 만드는 코드(ABCDE-12345)입니다. 코드를 넣으면 정해진 권한으로 참여합니다.</Term>
        <Term name="변경 제안">
          열람 권한이어도 바꿀 파일을 묶어 올릴 수 있습니다. 편집 권한이 있는 사람이 보고 반영하거나 닫습니다.
        </Term>
        <Term name="복구 코드">
          비밀번호를 잊었을 때 운영자 없이 새 비밀번호를 정하는 코드입니다. 내 정보에서 미리 만들어 안전한 곳에 적어 둡니다.
        </Term>
      </Section>

      <Section icon="shield-checkmark-outline" title="권한">
        {ROLES.map((role) => (
          <Term key={role} name={ROLE_LABEL[role]}>
            {ROLE_DESCRIPTION[role]}
          </Term>
        ))}
      </Section>

      <Section icon="medkit-outline" title="문제가 생겼을 때">
        {user ? (
          <HelpLink
            icon="key-outline"
            label="비밀번호를 잊을 때를 대비하기"
            description="내 정보에서 복구 코드를 만들어 두면, 잊어도 혼자 되찾을 수 있습니다."
            href="/settings"
          />
        ) : (
          <>
            <HelpLink
              icon="key-outline"
              label="비밀번호를 잊었어요"
              description="복구 코드나 운영자에게 받은 재설정 코드로 새 비밀번호를 정합니다."
              href="/reset-password"
            />
            <HelpLink
              icon="person-outline"
              label="아이디를 잊었어요"
              description="복구 코드, 같은 저장소 멤버, 운영자 — 세 가지 길이 있습니다."
              href="/forgot-id"
            />
          </>
        )}
        <HelpLink
          icon="cloud-offline-outline"
          label="서버에 들어가지지 않아요"
          description="서버가 꺼졌는지, 주소가 바뀌었는지, 버전이 다른지 차례로 확인합니다."
          href="/troubleshoot"
        />
        <HelpLink
          icon="phone-portrait-outline"
          label="기기를 잃어버렸어요"
          description={
            user
              ? '내 정보의 「다른 기기 모두 로그아웃」으로 다른 기기를 끊고, 비밀번호도 바꿉니다.'
              : '다른 기기에서 로그인해 내 정보의 「다른 기기 모두 로그아웃」을 누르고 비밀번호를 바꿉니다.'
          }
          href={user ? '/settings' : undefined}
        />
      </Section>

      {shortcutsSupported ? <ShortcutList /> : null}
    </Screen>
  );
}

/** 웹·PC 앱 키보드 단축키. 글을 쓰는 칸에서는 Esc 만 먹는다(lib/pure/shortcuts.ts). */
function ShortcutList() {
  const { colors } = useTheme();
  return (
    <Section icon="keypad-outline" title="키보드 단축키 (웹·PC 앱)">
      {SHORTCUTS.map((shortcut) => (
        <Row key={shortcut.action} gap={spacing.md} style={{ alignItems: 'flex-start' }}>
          <View
            style={{
              minWidth: 120,
              borderRadius: radius.sm,
              backgroundColor: colors.surfaceAlt,
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
            }}
          >
            <Body style={{ fontFamily: monoFont, fontSize: fontSize.sm }}>{shortcut.keys.join(' 또는 ')}</Body>
          </View>
          <Body style={{ flex: 1, fontSize: fontSize.sm }}>{shortcut.description}</Body>
        </Row>
      ))}
      <Caption>글을 쓰는 칸에 있을 때는 Esc 만 먹습니다.</Caption>
    </Section>
  );
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Card style={{ gap: spacing.md }}>
      <Row gap={spacing.sm}>
        <Ionicons name={icon} size={20} color={colors.accent} />
        <Body heading style={{ fontWeight: '600', flex: 1 }}>
          {title}
        </Body>
      </Row>
      {children}
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
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
        <Body style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: '700' }}>{n}</Body>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: '600' }}>{title}</Body>
        <Caption>{children}</Caption>
      </View>
    </Row>
  );
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <Body style={{ fontWeight: '600' }}>{name}</Body>
      <Caption>{children}</Caption>
    </View>
  );
}

function HelpLink({
  icon,
  label,
  description,
  href,
}: {
  icon: IconName;
  label: string;
  description: string;
  href?: Href;
}) {
  const { colors } = useTheme();
  const content = (
    <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={18} color={colors.textMuted} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: '600', color: href ? colors.accent : colors.text }}>{label}</Body>
        <Caption>{description}</Caption>
      </View>
      {href ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginTop: 2 }} /> : null}
    </Row>
  );
  return (
    <>
      <Divider />
      {href ? (
        <Pressable
          onPress={() => router.push(href)}
          accessibilityRole="link"
          accessibilityLabel={label}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          {content}
        </Pressable>
      ) : (
        content
      )}
    </>
  );
}
