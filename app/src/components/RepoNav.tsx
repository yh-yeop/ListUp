import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { fontSize, radius, spacing, useTheme } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface Tab {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  badge?: number;
}

/** 저장소 안의 화면들 사이를 오가는 탭. 모바일에서는 가로 스크롤된다. */
export function RepoNav({ repoId, openProposals }: { repoId: string; openProposals?: number }) {
  const { colors } = useTheme();
  const pathname = usePathname();

  const tabs: Tab[] = [
    { key: 'files', label: '파일', icon: 'document-text-outline', href: `/repo/${repoId}` },
    {
      key: 'proposals',
      label: '변경 제안',
      icon: 'git-pull-request-outline',
      href: `/repo/${repoId}/proposals`,
      badge: openProposals,
    },
    { key: 'members', label: '멤버', icon: 'people-outline', href: `/repo/${repoId}/members` },
    { key: 'invites', label: '초대', icon: 'key-outline', href: `/repo/${repoId}/invites` },
    { key: 'history', label: '변경 이력', icon: 'time-outline', href: `/repo/${repoId}/history` },
  ];

  const isActive = (tab: Tab) =>
    tab.key === 'files' ? pathname === `/repo/${repoId}` : pathname === tab.href;

  return (
    // 가로 ScrollView 는 그냥 두면 세로로 늘어나 아래 버튼을 덮어버린다.
    // 감싼 View 로 높이를 내용에 맞춘다.
    <View style={{ alignSelf: 'stretch' }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: spacing.xs, paddingVertical: 2, alignItems: 'center' }}
      >
        {tabs.map((tab) => {
        const active = isActive(tab);
        return (
          <Pressable
            key={tab.key}
            onPress={() => router.replace(tab.href as never)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              borderRadius: radius.pill,
              backgroundColor: active ? colors.accentSoft : 'transparent',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Ionicons
              name={tab.icon}
              size={15}
              color={active ? colors.accent : colors.textMuted}
            />
            <Text
              style={{
                color: active ? colors.accent : colors.textMuted,
                fontSize: fontSize.sm,
                fontWeight: active ? '700' : '500',
              }}
            >
              {tab.label}
            </Text>
            {tab.badge ? (
              <View
                style={{
                  backgroundColor: colors.warning,
                  borderRadius: radius.pill,
                  minWidth: 18,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: colors.warningText, fontSize: 11, fontWeight: '700' }}>
                  {tab.badge}
                </Text>
              </View>
            ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** 현재 폴더 위치를 보여주고, 눌러서 상위로 이동한다. */
export function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (nextPath: string) => void;
}) {
  const { colors } = useTheme();
  const segments = path === '' ? [] : path.split('/');

  return (
    <View style={{ alignSelf: 'stretch' }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Pressable
            onPress={() => onNavigate('')}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="최상위 폴더"
          >
            <Ionicons
              name="home"
              size={15}
              color={segments.length === 0 ? colors.text : colors.textMuted}
            />
          </Pressable>
          {segments.map((segment, index) => {
            const target = segments.slice(0, index + 1).join('/');
            const last = index === segments.length - 1;
            return (
              <View key={target} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="chevron-forward" size={13} color={colors.textFaint} />
                <Pressable
                  onPress={() => onNavigate(target)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`${segment} 폴더`}
                >
                  <Text
                    style={{
                      color: last ? colors.text : colors.textMuted,
                      fontSize: fontSize.sm,
                      fontWeight: last ? '600' : '400',
                    }}
                  >
                    {segment}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
