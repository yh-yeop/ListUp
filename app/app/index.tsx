import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { Loading } from '../src/components/ui';
import { useAuth } from '../src/state/auth';
import { useTheme } from '../src/theme';

/**
 * 저장된 토큰을 확인한 뒤 저장소 목록이나 로그인 화면으로 보낸다.
 * 앱을 열었을 때 어느 서버에도 로그인돼 있지 않고 서버가 여럿이면, 어느 서버로 들어갈지부터
 * 고르게 한다. 서버를 고른 뒤나 한 서버에서 로그아웃한 뒤에는 그 서버의 로그인 화면으로 간다.
 */
export default function Index() {
  const { user, loading, startAtServerList } = useAuth();
  const { colors } = useTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <Loading label="ListUp 시작하는 중…" />
      </View>
    );
  }

  if (user) return <Redirect href="/repos" />;
  return <Redirect href={startAtServerList ? '/servers' : '/login'} />;
}
