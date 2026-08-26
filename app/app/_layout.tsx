import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '../src/components/ui';
import { AuthProvider, useAuth } from '../src/state/auth';
import { useTheme } from '../src/theme';

/**
 * 저장된 토큰을 확인하는 동안에는 Stack 을 아직 그리지 않는다 — 화면이 먼저 뜨면
 * 토큰 복원 전에 요청이 나가 401 을 받는다. 확인이 끝나면 로그인 여부에 따라
 * 보호 라우트가 들어갈 수 있는 화면을 정한다. 로그아웃 상태에서 보호 화면 주소로
 * 들어오거나 세션이 끊기면 index 로 돌아가고, index 가 로그인 화면으로 보낸다.
 */
function RootNavigator() {
  const { user, loading } = useAuth();
  const { colors } = useTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <Loading label="ListUp 시작하는 중…" />
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
      <Stack.Screen name="server" options={{ title: '서버 주소' }} />

      {/* 로그인 전에만 */}
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="signup" options={{ title: '회원가입' }} />
      </Stack.Protected>

      {/* 로그인 후에만 */}
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="repos" options={{ title: 'ListUp' }} />
        <Stack.Screen name="join" options={{ title: '초대 코드로 참여' }} />
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
