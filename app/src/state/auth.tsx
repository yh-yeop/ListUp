import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@listup/shared';
import { api, setAuthToken, setUnauthorizedHandler } from '../api/client';

const TOKEN_KEY = 'listup.token';

interface AuthState {
  user: User | null;
  /** 저장된 토큰을 아직 확인 중인지. */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, displayName: string): Promise<void>;
  logout(): Promise<void>;
  updateProfile(displayName: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    void AsyncStorage.removeItem(TOKEN_KEY);
  }, []);

  // 토큰이 만료·폐기되면 어느 화면에 있든 로그인 화면으로 돌아가게 한다.
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // 앱을 다시 열었을 때 저장된 토큰으로 로그인 상태를 복구한다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await AsyncStorage.getItem(TOKEN_KEY);
        if (!token) return;
        setAuthToken(token);
        const { user: restored } = await api.me();
        if (!cancelled) setUser(restored);
      } catch {
        setAuthToken(null);
        await AsyncStorage.removeItem(TOKEN_KEY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (token: string, nextUser: User) => {
    setAuthToken(token);
    await AsyncStorage.setItem(TOKEN_KEY, token);
    setUser(nextUser);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      async login(email, password) {
        const result = await api.login({ email, password });
        await persist(result.token, result.user);
      },
      async signup(email, password, displayName) {
        const result = await api.signup({ email, password, displayName });
        await persist(result.token, result.user);
      },
      async logout() {
        clearSession();
      },
      async updateProfile(displayName) {
        const result = await api.updateProfile({ displayName });
        setUser(result.user);
      },
    }),
    [user, loading, persist, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있습니다.');
  return ctx;
}
