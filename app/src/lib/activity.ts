import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import type { ActivityItem } from '@listup/shared';
import { api, serverSupports } from '../api/client';
import { LEVEL_1_4 } from './useServerLevel';

/**
 * 새 소식의 "읽지 않음" — 서버마다 마지막으로 본 시각을 기기에 둔다. 그 뒤의 것 중 내가 한 일이 아닌 것을 센다.
 * 푸시 알림은 없다(서버가 밖으로 보내는 길이 없다) — 앱을 열 때와 저장소 목록으로 돌아올 때 묻는다.
 */

const keyOf = (serverId: string) => `listup.activity.seen.${serverId}`;

export async function loadSeenAt(serverId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(serverId));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function markSeen(serverId: string, at = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(keyOf(serverId), String(at));
  } catch {
    // 기기 저장소가 막혀 있으면 다음에 또 읽지 않음으로 보일 뿐이다.
  }
}

export const unreadOf = (items: ActivityItem[], seenAt: number) => items.filter((item) => !item.mine && item.at > seenAt).length;

/** 저장소 목록이 배지에 쓴다. 1.4.0 서버가 아니면 null(배지 없음). */
export function useUnreadActivity(serverId: string, refreshKey = 0): number | null {
  const [count, setCount] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (!(await serverSupports(LEVEL_1_4))) return;
    try {
      const seenAt = await loadSeenAt(serverId);
      const { items } = await api.activity(seenAt, 100);
      setCount(unreadOf(items, seenAt));
    } catch {
      // 소식은 덤이다.
    }
  }, [serverId]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  return count;
}
