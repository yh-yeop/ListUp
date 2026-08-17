import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { Loading } from '../src/components/ui';
import { useAuth } from '../src/state/auth';
import { useTheme } from '../src/theme';

/** 저장된 토큰을 확인한 뒤 로그인 화면이나 저장소 목록으로 보낸다. */
export default function Index() {
  const { user, loading } = useAuth();
  const { colors } = useTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <Loading label="ListUp 시작하는 중…" />
      </View>
    );
  }

  return <Redirect href={user ? '/repos' : '/login'} />;
}
