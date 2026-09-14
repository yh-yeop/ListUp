import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '../src/components/ui';
import { suggestUpdateOnce } from '../src/lib/updates';
import { AuthProvider, useAuth } from '../src/state/auth';
import { useTheme } from '../src/theme';

/**
 * 저장된 토큰을 확인하는 동안에는 Stack 을 아직 그리지 않는다 — 화면이 먼저 뜨면
 * 토큰 복원 전에 요청이 나가 401 을 받는다. 확인이 끝나면 로그인 여부에 따라
 * 보호 라우트가 들어갈 수 있는 화면을 정한다. 로그아웃 상태에서 보호 화면 주소로
 * 들어오거나 세션이 끊기면 index 로 돌아가고, index 가 로그인 화면으로 보낸다.
 *
 * 서버에 새로 들어가면(serverGeneration) 스택을 비우고 index 로 보낸다. 서버 목록은 늘 스택
 * 맨 아래에서 열리므로(lib/server-list.ts) 비우면 목록만 남고, 보호 라우트와 엇갈리지 않는다.
 * 이동을 화면이 아니라 여기서 하는 이유는, 전환하는 동안 로딩 화면을 보이느라 Stack 이
 * 내려가 화면의 상태가 사라지기 때문이다.
 */
function RootNavigator() {
  const { user, loading, entering, serverGeneration } = useAuth();
  const { colors } = useTheme();

  // 설치형 클라이언트는 앱을 열 때 새 버전이 있는지 보고, 있으면 한 번 제안한다.
  useEffect(() => {
    if (!loading) void suggestUpdateOnce();
  }, [loading]);

  useEffect(() => {
    if (serverGeneration === 0) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  }, [serverGeneration]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <Loading label={entering ? '서버에 들어가는 중…' : 'ListUp 시작하는 중…'} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      {/* 로그인 전후 모두 접근하는 화면 */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="servers" options={{ title: '서버' }} />
      <Stack.Screen name="server" options={{ title: '서버 추가' }} />
      {/* 초대 링크는 로그인 전에도 연다 — 코드를 들고 로그인·가입으로 보낸다. */}
      <Stack.Screen name="join" options={{ title: '초대 코드로 참여' }} />

      {/* 로그인 전에만 */}
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="signup" options={{ title: '회원가입' }} />
        <Stack.Screen name="reset-password" options={{ title: '비밀번호 재설정' }} />
      </Stack.Protected>

      {/* 로그인 후에만 */}
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="repos" options={{ title: 'ListUp' }} />
        <Stack.Screen name="settings" options={{ title: '내 정보' }} />
        <Stack.Screen name="repo/[repoId]/index" />
        <Stack.Screen name="repo/[repoId]/proposals" />
        <Stack.Screen name="repo/[repoId]/members" />
        <Stack.Screen name="repo/[repoId]/invites" />
        <Stack.Screen name="repo/[repoId]/history" />
        <Stack.Screen name="repo/[repoId]/new-proposal" />
        <Stack.Screen name="proposal/[proposalId]" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const { dark } = useTheme();

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
