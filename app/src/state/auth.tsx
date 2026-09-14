import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@listup/shared';
import { ApiError, IS_CLIENT_BUILD, api, setApiTarget, setUnauthorizedHandler } from '../api/client';
import { loadLogin, removeLogin, saveLogin } from '../lib/credentials';
import {
  DEFAULT_SERVER_ID,
  activeServer,
  checkServer,
  describeCheck,
  findServer,
  ServerCheckError,
  initialStore,
  isDefaultServer,
  loadServers,
  newServerId,
  saveServers,
  serverUrl,
  type ServerEntry,
  type ServerStore,
} from './servers';

interface AuthState {
  user: User | null;
  /** 저장된 토큰을 아직 확인 중인지 — 앱을 열 때와 서버를 바꿀 때. */
  loading: boolean;
  /** 서버에 들어가는 중인지 (loading 중 서버 전환 때문인 경우). 안내 문구용. */
  entering: boolean;
  /**
   * 서버에 새로 들어갈 때마다 1 씩 오른다. 화면들은 이 값으로 새로 시작한다 —
   * 이전 서버의 화면(그 서버의 저장소 id 와 데이터)이 스택에 남지 않게.
   */
  serverGeneration: number;
  /** 이 기기가 기억하는 서버. 기본 서버가 맨 앞이다. */
  servers: ServerEntry[];
  /** 지금 요청을 보내는 서버. 클라이언트 모드에서 아직 고르지 않았으면 null. */
  activeServer: ServerEntry | null;
  /**
   * 로그인돼 있지 않을 때 로그인 화면 대신 서버 목록을 보여줘야 하는지. 서버를 고르거나
   * 로그인하면 꺼진다.
   * - 서버 모드: 앱을 열었을 때 로그인돼 있지 않고 서버가 여럿이면.
   * - 클라이언트 모드: 로그인돼 있지 않은 채 앱을 열었거나, 로그아웃·세션 만료·지금 서버를
   *   지웠을 때 (마인크래프트의 타이틀 화면처럼 목록으로 돌아간다).
   */
  startAtServerList: boolean;
  /** remember 가 true 면 로그인 정보를 기기에 저장하고, false 면 저장돼 있던 것을 지운다. */
  login(email: string, password: string, options?: { remember?: boolean }): Promise<void>;
  signup(
    email: string,
    password: string,
    displayName: string,
    options?: { remember?: boolean },
  ): Promise<void>;
  /**
   * 서버 운영자에게 받은 재설정 코드로 새 비밀번호를 정하고 그대로 로그인한다.
   * 그 계정의 다른 기기 로그인은 서버가 끊는다.
   */
  resetPassword(
    email: string,
    code: string,
    newPassword: string,
    options?: { remember?: boolean },
  ): Promise<void>;
  /** 지금 서버에서만 로그아웃한다. 다른 서버의 로그인은 그대로다. */
  logout(): Promise<void>;
  updateProfile(displayName: string): Promise<void>;
  /** 비밀번호를 바꾸고, 서버가 새로 준 토큰으로 이 기기의 세션을 이어 간다. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /**
   * 연결을 확인한 뒤 그 서버로 옮긴다. 닿지 않거나 API 버전이 다르면 아무것도 바꾸지 않고
   * 이유를 담은 오류를 던진다.
   */
  switchServer(id: string): Promise<void>;
  /**
   * 서버를 더하거나(id 없음) 고친다. 주소는 정리·확인을 마친 값이어야 한다.
   * 주소를 바꾸면 그 서버의 로그인은 지운다 — 토큰은 발급한 서버에만 보낸다.
   * 돌려주는 값은 그 항목의 id.
   */
  saveServer(input: { id?: string; url: string; label: string | null }): Promise<string>;
  /** 서버를 목록에서 지운다. 지금 서버를 지우면 기본 서버로 옮긴다. */
  removeServer(id: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const INITIAL_STORE: ServerStore = initialStore();

/** 서버를 고르지 않은 채 로그인하려 할 때. 화면에서는 서버 목록으로 안내한다. */
function noServerError(): Error {
  return new Error('들어갈 서버를 먼저 골라 주세요.');
}

function updateEntry(
  store: ServerStore,
  id: string,
  change: (entry: ServerEntry) => ServerEntry,
): ServerStore {
  return { ...store, servers: store.servers.map((entry) => (entry.id === id ? change(entry) : entry)) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [store, setStore] = useState<ServerStore>(INITIAL_STORE);
  const [startAtServerList, setStartAtServerList] = useState(false);
  const [entering, setEntering] = useState(false);
  const [serverGeneration, setServerGeneration] = useState(0);

  // 비동기 흐름 안에서 최신 목록을 읽기 위한 사본. 바꾸는 길은 commit 하나뿐이다.
  const storeRef = useRef<ServerStore>(INITIAL_STORE);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * 목록을 바꾸고 저장한다. 바꾸기는 한 줄로 세워 차례로 한다 — 동시에 두 곳에서 바꾸면
   * 한쪽의 변경이 사라지거나, 늦게 끝난 저장이 새 값을 덮어쓸 수 있기 때문이다.
   * 저장에 실패하면 메모리도 바꾸지 않는다(표시와 실제가 어긋나지 않게). 다만 세션을 끊는
   * 변경은 저장에 실패해도 메모리에서는 반영해야 하므로 evenIfNotSaved 를 쓴다.
   */
  const commit = useCallback(
    (change: (current: ServerStore) => ServerStore, options?: { evenIfNotSaved?: boolean }) => {
      const run = queueRef.current.then(async () => {
        const next = change(storeRef.current);
        try {
          await saveServers(next);
        } catch (err) {
          if (!options?.evenIfNotSaved) throw err;
        }
        storeRef.current = next;
        setStore(next);
        return next;
      });
      queueRef.current = run.catch(() => undefined);
      return run;
    },
    [],
  );

  /** 로그인·가입으로 받은 토큰을 요청을 보냈던 그 서버에 넣는다. */
  const acceptSession = useCallback(
    async (id: string, url: string, token: string, nextUser: User) => {
      await commit((s) =>
        updateEntry(s, id, (e) => ({
          ...e,
          token,
          user: nextUser,
          lastUsedAt: Date.now(),
          signedOut: false,
        })),
      );
      setStartAtServerList(false);
      if (storeRef.current.activeId !== id) return;
      setApiTarget(url, token);
      setUser(nextUser);
    },
    [commit],
  );

  /**
   * 저장된 로그인 정보로 그 서버에 다시 로그인한다. 세션을 이었는지 돌려준다.
   * 요청 대상은 부르는 쪽이 이미 이 서버로, 토큰 없이 맞춰 두었다.
   *
   * 직접 로그아웃한 서버에는 하지 않는다. 비밀번호 오류로 실패하면 저장된 비밀번호를 지운다 —
   * 앱을 열 때마다 틀린 비밀번호로 시도하면 서버의 로그인 실패 제한에 걸려 본인이 막힌다.
   * 오프라인·요청 제한(429)은 비밀번호 문제가 아니므로 그대로 둔다.
   */
  const autoLogin = useCallback(
    async (entry: ServerEntry): Promise<boolean> => {
      if (entry.signedOut) return false;
      const saved = await loadLogin(entry.id);
      if (!saved?.password || storeRef.current.activeId !== entry.id) return false;
      try {
        const result = await api.login({ email: saved.email, password: saved.password });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
        return storeRef.current.activeId === entry.id;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await saveLogin(entry.id, { email: saved.email, password: null }).catch(() => undefined);
        }
        return false;
      }
    },
    [acceptSession],
  );

  /**
   * 그 서버로 요청 대상을 옮기고, 기억해 둔 토큰이 아직 유효한지 서버에 물어 세션을 정한다.
   * 토큰이 없거나 만료·폐기됐으면 저장된 로그인 정보로 다시 로그인해 본다.
   * 돌려주는 값은 세션을 이었는지.
   *
   * 요청 대상을 옮기는 순간 이전 서버의 사용자도 내린다 — 둘이 다른 서버를 가리키는 틈을
   * 두지 않는다. 확인하기 전에 기억해 둔 사용자를 띄우지도 않는다 — 토큰이 폐기됐다면
   * 로그인된 것처럼 보였다가 풀리게 된다.
   */
  const activate = useCallback(
    async (entry: ServerEntry | null): Promise<boolean> => {
      if (!entry) {
        setApiTarget(null, null);
        setUser(null);
        return false;
      }
      const { id, token } = entry;
      setApiTarget(serverUrl(entry), token);
      setUser(null);
      if (!token) return autoLogin(entry);
      // 그사이 다른 서버로 옮겼거나 다시 로그인했다면 이 결과는 버린다.
      const stillCurrent = () => {
        const current = storeRef.current;
        return current.activeId === id && findServer(current, id)?.token === token;
      };
      try {
        const { user: fresh } = await api.me();
        if (!stillCurrent()) return false;
        setUser(fresh);
        await commit((s) =>
          updateEntry(s, id, (e) => ({ ...e, user: fresh, lastUsedAt: Date.now() })),
        ).catch(() => undefined);
        return true;
      } catch (err) {
        // 401 이면 client 가 이미 아래 핸들러로 이 서버의 세션(토큰)을 지웠다. 저장된 계정이 있으면
        // 다시 로그인한다 — 토큰 30일이 지났을 뿐이면 끊긴 줄 모르고 이어진다.
        if (err instanceof ApiError && err.status === 401) {
          // 핸들러가 토큰을 지웠으므로 stillCurrent() 는 거짓이다. 그사이 다른 서버로 옮겼는지만 본다.
          if (storeRef.current.activeId !== id) return false;
          return autoLogin({ ...entry, token: null });
        }
        // 서버가 꺼져 있거나 오프라인 — 토큰은 두고 마지막으로 알던 사용자로 세션을 잇는다.
        if (!stillCurrent() || !entry.user) return false;
        setUser(entry.user);
        return true;
      }
    },
    [commit, autoLogin],
  );

  // 토큰이 만료·폐기되면 그 토큰을 가진 서버에서만 로그아웃한다. 다른 서버는 그대로다.
  useEffect(() => {
    setUnauthorizedHandler((token) => {
      // client 는 지금 서버의 지금 토큰일 때만 부르므로, 화면의 사용자는 바로 내린다.
      setUser(null);
      if (IS_CLIENT_BUILD) setStartAtServerList(true);
      void commit(
        (s) => ({
          ...s,
          servers: s.servers.map((e) => (e.token === token ? { ...e, token: null, user: null } : e)),
        }),
        { evenIfNotSaved: true },
      ).catch(() => undefined);
    });
    return () => setUnauthorizedHandler(null);
  }, [commit]);

  // 앱을 다시 열었을 때 지금 서버와 그 서버의 토큰으로 로그인 상태를 복구한다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadServers();
        if (cancelled) return;
        storeRef.current = loaded;
        setStore(loaded);

        const entered = await activate(activeServer(loaded));
        if (!cancelled) {
          setStartAtServerList(!entered && (IS_CLIENT_BUILD || loaded.servers.length > 1));
        }
      } catch {
        // 저장소를 읽지 못한 경우 — 서버 모드는 기본 서버의 로그인 화면, 클라이언트 모드는
        // 빈 서버 목록에서 다시 시작한다.
        const fallback = activeServer(storeRef.current);
        setApiTarget(fallback ? serverUrl(fallback) : null, null);
        if (IS_CLIENT_BUILD && !cancelled) setStartAtServerList(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activate]);

  /**
   * 그 서버에 새로 들어간다 — 앱을 다시 여는 것과 같다. 확인하는 동안 로딩 화면을 보이고,
   * 끝나면 serverGeneration 을 올린다. _layout 이 그 값을 보고 스택을 비워 index 로 보낸다.
   */
  const enter = useCallback(
    async (entry: ServerEntry | null) => {
      setEntering(true);
      setLoading(true);
      try {
        await activate(entry);
      } finally {
        setLoading(false);
        setEntering(false);
        setServerGeneration((n) => n + 1);
      }
    },
    [activate],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      entering,
      serverGeneration,
      servers: store.servers,
      activeServer: activeServer(store),
      startAtServerList,

      async login(email, password, options) {
        const entry = activeServer(storeRef.current);
        if (!entry) throw noServerError();
        const result = await api.login({ email, password });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
        await rememberLogin(entry.id, email, password, options?.remember);
      },

      async signup(email, password, displayName, options) {
        const entry = activeServer(storeRef.current);
        if (!entry) throw noServerError();
        const result = await api.signup({ email, password, displayName });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
        await rememberLogin(entry.id, email, password, options?.remember);
      },

      async resetPassword(email, code, newPassword, options) {
        const entry = activeServer(storeRef.current);
        if (!entry) throw noServerError();
        const result = await api.resetPassword({ email, code, newPassword });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
        // 저장을 끈 채 재설정해도, 예전 비밀번호가 남아 있으면 다음 자동 로그인이 실패하므로 지운다.
        await rememberLogin(entry.id, email, newPassword, options?.remember ?? false);
      },

      async logout() {
        const entry = activeServer(storeRef.current);
        // 토큰을 먼저 메모리에서 내려 더는 보내지 않게 한 뒤 저장한다.
        setApiTarget(entry ? serverUrl(entry) : null, null);
        setUser(null);
        if (IS_CLIENT_BUILD) setStartAtServerList(true);
        if (!entry) return;
        // 직접 로그아웃한 서버는 저장된 계정으로 자동으로 다시 들어가지 않는다.
        await commit(
          (s) => updateEntry(s, entry.id, (e) => ({ ...e, token: null, user: null, signedOut: true })),
          { evenIfNotSaved: true },
        ).catch(() => undefined);
      },

      async changePassword(currentPassword, newPassword) {
        const entry = activeServer(storeRef.current);
        if (!entry) throw noServerError();
        const result = await api.changePassword({ currentPassword, newPassword });
        // 서버가 토큰 세대를 올려 이전 토큰을 모두 끊었다. 이 기기만 새 토큰으로 이어 간다.
        if (storeRef.current.activeId === entry.id) setApiTarget(serverUrl(entry), result.token);
        await commit((s) => updateEntry(s, entry.id, (e) => ({ ...e, token: result.token })), {
          evenIfNotSaved: true,
        });
        // 저장해 둔 비밀번호가 있으면 새 비밀번호로 바꿔 둔다. 안 그러면 다음 자동 로그인이 실패한다.
        const saved = await loadLogin(entry.id);
        if (saved?.password) {
          await saveLogin(entry.id, { email: saved.email, password: newPassword }).catch(() => undefined);
        }
      },

      async updateProfile(displayName) {
        const entry = activeServer(storeRef.current);
        if (!entry) throw noServerError();
        const result = await api.updateProfile({ displayName });
        if (storeRef.current.activeId === entry.id) setUser(result.user);
        await commit((s) => updateEntry(s, entry.id, (e) => ({ ...e, user: result.user }))).catch(
          () => undefined,
        );
      },

      async switchServer(id) {
        const target = findServer(storeRef.current, id);
        if (!target) throw new Error('목록에 없는 서버입니다.');
        const url = serverUrl(target);
        const check = await checkServer(url);
        const problem = describeCheck(check, url);
        if (problem) throw new ServerCheckError(problem, check);
        const next = await commit((s) => ({
          ...updateEntry(s, id, (e) => ({ ...e, lastUsedAt: Date.now() })),
          activeId: id,
        }));
        setStartAtServerList(false);
        await enter(findServer(next, id)!);
      },

      async saveServer({ id, url, label }) {
        const current = storeRef.current;
        const cleanLabel = label?.trim() || null;

        if (!id) {
          // 이미 있는 주소면 새로 만들지 않고 그 항목을 쓴다.
          const existing = current.servers.find((e) => serverUrl(e) === url);
          if (existing) {
            if (cleanLabel && cleanLabel !== existing.label) {
              await commit((s) => updateEntry(s, existing.id, (e) => ({ ...e, label: cleanLabel })));
            }
            return existing.id;
          }
          const created: ServerEntry = {
            id: newServerId(),
            url,
            label: cleanLabel,
            token: null,
            user: null,
            lastUsedAt: null,
            signedOut: false,
          };
          await commit((s) => ({ ...s, servers: [...s.servers, created] }));
          return created.id;
        }

        const target = findServer(current, id);
        if (!target) throw new Error('목록에 없는 서버입니다.');
        // 기본 서버의 주소는 앱이 정한다. 이름만 바꿀 수 있다.
        const urlChanged = !isDefaultServer(target) && url !== target.url;
        if (urlChanged && current.servers.some((e) => e.id !== id && serverUrl(e) === url)) {
          throw new Error('이미 목록에 있는 주소입니다.');
        }
        const next = await commit((s) =>
          updateEntry(s, id, (e) =>
            urlChanged
              ? { ...e, url, label: cleanLabel, token: null, user: null }
              : { ...e, label: cleanLabel },
          ),
        );
        if (urlChanged) {
          // 저장된 비밀번호는 지우고 이메일만 남긴다. 주소를 잘못 넣어 다른 서버로 바뀌었다면,
          // 자동 로그인이 그 서버 주인에게 비밀번호를 보내게 된다.
          const saved = await loadLogin(id);
          if (saved) await saveLogin(id, { email: saved.email, password: null }).catch(() => undefined);
        }
        // 지금 서버의 주소를 바꿨다면 로그인이 풀렸으므로 그 서버에 새로 들어간다.
        if (urlChanged && next.activeId === id) await enter(findServer(next, id)!);
        return id;
      },

      async removeServer(id) {
        const target = findServer(storeRef.current, id);
        if (!target) return;
        if (isDefaultServer(target)) throw new Error('기본 서버는 지울 수 없습니다.');
        const wasActive = storeRef.current.activeId === id;
        // 지금 서버를 지우면 서버 모드는 기본 서버로, 클라이언트 모드는 고른 서버 없이 목록으로.
        const fallbackId = IS_CLIENT_BUILD ? null : DEFAULT_SERVER_ID;
        const next = await commit((s) => ({
          ...s,
          activeId: s.activeId === id ? fallbackId : s.activeId,
          servers: s.servers.filter((e) => e.id !== id),
        }));
        await removeLogin(id);
        if (!wasActive) return;
        if (IS_CLIENT_BUILD) setStartAtServerList(true);
        await enter(activeServer(next));
      },
    }),
    [user, loading, entering, serverGeneration, store, startAtServerList, commit, acceptSession, enter],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 로그인할 때 "저장" 을 켰으면 저장하고, 껐으면 저장돼 있던 것을 지운다. 정하지 않았으면 그대로. */
async function rememberLogin(
  serverId: string,
  email: string,
  password: string,
  remember: boolean | undefined,
): Promise<void> {
  if (remember === undefined) return;
  if (remember) await saveLogin(serverId, { email, password }).catch(() => undefined);
  else await removeLogin(serverId);
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있습니다.');
  return ctx;
}
