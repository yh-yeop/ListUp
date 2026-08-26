import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@listup/shared';
import {
  API_URL_STORAGE_KEY,
  ApiError,
  api,
  setApiBaseUrl,
  setAuthToken,
  setUnauthorizedHandler,
} from '../api/client';

const TOKEN_KEY = 'listup.token';
/** 마지막으로 확인한 사용자 정보. 서버에 닿지 못할 때 세션을 잇는 데 쓴다. */
const USER_KEY = 'listup.user';

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

/** 저장해 둔 사용자 정보를 읽는다. 깨져 있으면 null. */
function readCachedUser(raw: string | null): User | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<User> | null;
    return parsed && typeof parsed.id === 'string' ? (parsed as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    void AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
  }, []);

  // 토큰이 만료·폐기되면 어느 화면에 있든 로그인 화면으로 돌아가게 한다.
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // 앱을 다시 열었을 때 저장된 서버 주소와 토큰으로 로그인 상태를 복구한다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 서버 주소를 먼저 적용해야 아래 요청이 올바른 서버로 간다.
        setApiBaseUrl(await AsyncStorage.getItem(API_URL_STORAGE_KEY));

        const token = await AsyncStorage.getItem(TOKEN_KEY);
        if (!token) return;
        setAuthToken(token);

        try {
          const { user: restored } = await api.me();
          if (cancelled) return;
          setUser(restored);
          await AsyncStorage.setItem(USER_KEY, JSON.stringify(restored));
        } catch (err) {
          // 토큰이 만료·폐기된 경우에만 로그아웃한다.
          if (err instanceof ApiError && err.status === 401) {
            clearSession();
            return;
          }
          // 서버가 꺼져 있거나 오프라인 — 토큰은 두고, 마지막으로 알던 사용자로 세션을 잇는다.
          const cached = readCachedUser(await AsyncStorage.getItem(USER_KEY));
          if (cached && !cancelled) setUser(cached);
        }
      } catch {
        // 저장소를 읽지 못한 경우 — 로그인 화면에서 다시 시작한다.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const persist = useCallback(async (token: string, nextUser: User) => {
    setAuthToken(token);
    await AsyncStorage.multiSet([
      [TOKEN_KEY, token],
      [USER_KEY, JSON.stringify(nextUser)],
    ]);
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
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(result.user));
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
