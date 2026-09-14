import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@listup/shared';
import { ApiError, api, setApiTarget, setUnauthorizedHandler } from '../api/client';
import {
  DEFAULT_SERVER_ID,
  activeServer,
  checkServer,
  describeUrl,
  findServer,
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
  /** 지금 요청을 보내는 서버. */
  activeServer: ServerEntry;
  /**
   * 앱을 열었을 때 어느 서버에도 로그인돼 있지 않고 서버가 여럿이라, 서버 목록부터 보여줘야
   * 하는지. 서버를 고르거나 로그인하면 꺼진다.
   */
  startAtServerList: boolean;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, displayName: string): Promise<void>;
  /** 지금 서버에서만 로그아웃한다. 다른 서버의 로그인은 그대로다. */
  logout(): Promise<void>;
  updateProfile(displayName: string): Promise<void>;
  /** 비밀번호를 바꾸고, 서버가 새로 준 토큰으로 이 기기의 세션을 이어 간다. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** 연결을 확인한 뒤 그 서버로 옮긴다. 닿지 않으면 아무것도 바꾸지 않고 오류를 던진다. */
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

const INITIAL_STORE: ServerStore = {
  version: 1,
  activeId: DEFAULT_SERVER_ID,
  servers: [{ id: DEFAULT_SERVER_ID, url: '', label: null, token: null, user: null, lastUsedAt: null }],
};

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

  /**
   * 그 서버로 요청 대상을 옮기고, 기억해 둔 토큰이 아직 유효한지 서버에 물어 세션을 정한다.
   * 돌려주는 값은 세션을 이었는지.
   *
   * 요청 대상을 옮기는 순간 이전 서버의 사용자도 내린다 — 둘이 다른 서버를 가리키는 틈을
   * 두지 않는다. 확인하기 전에 기억해 둔 사용자를 띄우지도 않는다 — 토큰이 폐기됐다면
   * 로그인된 것처럼 보였다가 풀리게 된다.
   */
  const activate = useCallback(
    async (entry: ServerEntry): Promise<boolean> => {
      const { id, token } = entry;
      setApiTarget(serverUrl(entry), token);
      setUser(null);
      if (!token) return false;
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
        // 401 이면 client 가 이미 아래 핸들러로 이 서버의 세션을 지웠다.
        if (err instanceof ApiError && err.status === 401) return false;
        // 서버가 꺼져 있거나 오프라인 — 토큰은 두고 마지막으로 알던 사용자로 세션을 잇는다.
        if (!stillCurrent() || !entry.user) return false;
        setUser(entry.user);
        return true;
      }
    },
    [commit],
  );

  // 토큰이 만료·폐기되면 그 토큰을 가진 서버에서만 로그아웃한다. 다른 서버는 그대로다.
  useEffect(() => {
    setUnauthorizedHandler((token) => {
      // client 는 지금 서버의 지금 토큰일 때만 부르므로, 화면의 사용자는 바로 내린다.
      setUser(null);
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
        if (!cancelled) setStartAtServerList(!entered && loaded.servers.length > 1);
      } catch {
        // 저장소를 읽지 못한 경우 — 기본 서버의 로그인 화면에서 다시 시작한다.
        setApiTarget(serverUrl(activeServer(storeRef.current)), null);
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
    async (entry: ServerEntry) => {
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

  /** 로그인·가입으로 받은 토큰을 요청을 보냈던 그 서버에 넣는다. */
  const acceptSession = useCallback(
    async (id: string, url: string, token: string, nextUser: User) => {
      await commit((s) =>
        updateEntry(s, id, (e) => ({ ...e, token, user: nextUser, lastUsedAt: Date.now() })),
      );
      setStartAtServerList(false);
      if (storeRef.current.activeId !== id) return;
      setApiTarget(url, token);
      setUser(nextUser);
    },
    [commit],
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

      async login(email, password) {
        const entry = activeServer(storeRef.current);
        const result = await api.login({ email, password });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
      },

      async signup(email, password, displayName) {
        const entry = activeServer(storeRef.current);
        const result = await api.signup({ email, password, displayName });
        await acceptSession(entry.id, serverUrl(entry), result.token, result.user);
      },

      async logout() {
        const entry = activeServer(storeRef.current);
        // 토큰을 먼저 메모리에서 내려 더는 보내지 않게 한 뒤 저장한다.
        setApiTarget(serverUrl(entry), null);
        setUser(null);
        await commit((s) => updateEntry(s, entry.id, (e) => ({ ...e, token: null, user: null })), {
          evenIfNotSaved: true,
        }).catch(() => undefined);
      },

      async changePassword(currentPassword, newPassword) {
        const entry = activeServer(storeRef.current);
        const result = await api.changePassword({ currentPassword, newPassword });
        // 서버가 토큰 세대를 올려 이전 토큰을 모두 끊었다. 이 기기만 새 토큰으로 이어 간다.
        if (storeRef.current.activeId === entry.id) setApiTarget(serverUrl(entry), result.token);
        await commit((s) => updateEntry(s, entry.id, (e) => ({ ...e, token: result.token })), {
          evenIfNotSaved: true,
        });
      },

      async updateProfile(displayName) {
        const entry = activeServer(storeRef.current);
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
        if (!(await checkServer(url))) {
          throw new Error(
            `${describeUrl(url)} 에서 ListUp 서버 응답을 받지 못했습니다.\n서버가 켜져 있는지 확인해 주세요.`,
          );
        }
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
        // 지금 서버의 주소를 바꿨다면 로그인이 풀렸으므로 그 서버에 새로 들어간다.
        if (urlChanged && next.activeId === id) await enter(findServer(next, id)!);
        return id;
      },

      async removeServer(id) {
        const target = findServer(storeRef.current, id);
        if (!target) return;
        if (isDefaultServer(target)) throw new Error('기본 서버는 지울 수 없습니다.');
        const wasActive = storeRef.current.activeId === id;
        const next = await commit((s) => ({
          ...s,
          activeId: s.activeId === id ? DEFAULT_SERVER_ID : s.activeId,
          servers: s.servers.filter((e) => e.id !== id),
        }));
        if (wasActive) await enter(activeServer(next));
      },
    }),
    [user, loading, entering, serverGeneration, store, startAtServerList, commit, acceptSession, enter],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있습니다.');
  return ctx;
}
