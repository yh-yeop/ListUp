import { useEffect, useState } from 'react';
import { getServerInfo } from '../api/client';

/**
 * 지금 서버의 기능 수준(API_LEVEL). 모르는 동안은 0 — 그동안은 새 기능을 감춘다.
 * 1.4.0 의 기능(되돌리기·공개 링크·충돌 정리·용량·따라가기)은 4 부터.
 */
export function useServerLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let alive = true;
    void getServerInfo().then((info) => {
      if (alive) setLevel(typeof info.apiLevel === 'number' ? info.apiLevel : 1);
    });
    return () => {
      alive = false;
    };
  }, []);
  return level;
}

/** 1.4.0 기능이 있는 서버의 수준. */
export const LEVEL_1_4 = 4;

/** 파일 찾기·새 소식·여러 개 옮기기·이동 제안이 있는 서버의 수준. */
export const LEVEL_1_5 = 5;
