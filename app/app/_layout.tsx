import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/state/auth';
import { useTheme } from '../src/theme';

export default function RootLayout() {
  const { colors, dark } = useTheme();

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '600' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="signup" options={{ title: '회원가입' }} />
          <Stack.Screen name="repos" options={{ title: 'ListUp' }} />
          <Stack.Screen name="join" options={{ title: '초대 코드로 참여' }} />
          <Stack.Screen name="settings" options={{ title: '내 정보' }} />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
