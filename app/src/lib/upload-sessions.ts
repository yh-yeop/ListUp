import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  forgetSession,
  lookupSession,
  parseSessions,
  pruneSessions,
  rememberSession,
  type SessionMemo,
} from './pure/upload-sessions';

/**
 * 끊긴 나눠 올리기 세션을 기기에 기억한다(웹은 localStorage, 앱은 AsyncStorage). 규칙은 pure/upload-sessions.ts.
 * 기억을 못 읽거나 못 써도 올리기는 그대로 간다 — 이어 가지 못하고 처음부터 보낼 뿐이다.
 */

const KEY = 'listup.uploadSessions';

/** 읽고-고치고-쓰기를 한 줄로 세운다. 겹치면 앞의 쓰기가 뒤의 것에 덮여 사라진다. */
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<SessionMemo> {
  return parseSessions(await AsyncStorage.getItem(KEY).catch(() => null));
}

function update(change: (memo: SessionMemo, now: number) => SessionMemo): Promise<void> {
  queue = queue
    .then(async () => {
      const next = change(await load(), Date.now());
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    })
    .catch(() => undefined);
  return queue;
}

/** 이 키로 기억한 세션 id. 없으면 null. */
export async function rememberedUpload(key: string): Promise<string | null> {
  await queue;
  return lookupSession(await load(), key, Date.now());
}

/** 세션을 기억한다 — 시작했을 때. 오래된 것은 이때 같이 잊는다. */
export function rememberUpload(key: string, uploadId: string): Promise<void> {
  return update((memo, now) => rememberSession(memo, key, uploadId, now));
}

/** 세션을 잊는다 — 다 올렸거나, 멈췄거나, 다시 쓸 수 없을 때. */
export function forgetUpload(key: string): Promise<void> {
  return update((memo, now) => pruneSessions(forgetSession(memo, key), now));
}
