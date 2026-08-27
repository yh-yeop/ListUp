/**
 * 로그인 대입 공격을 늦추는 실패 횟수 제한.
 *
 * 서버가 단일 프로세스라 메모리에만 둔다 — 재시작하면 초기화되지만, 대입 공격은 짧은 시간에
 * 수천 번을 시도하는 것이라 그 사이를 막는 것으로 충분하다. 여러 프로세스로 늘릴 때는
 * 공용 저장소(예: SQLite 테이블)로 옮겨야 한다.
 *
 * **성공한 요청은 세지 않는다.** 정상 사용자가 자기 계정을 정상적으로 오가는 것은 막지 않고,
 * 틀린 시도만 센다.
 */

export interface RateLimitOptions {
  /** 이 횟수까지는 실패해도 통과시킨다. */
  limit: number;
  /** 마지막 실패로부터 이 시간이 지나면 기록을 지운다(ms). */
  windowMs: number;
  /** 막혔을 때 다시 열릴 때까지의 시간(ms). */
  blockMs: number;
  /** 기억할 최대 키 수 — 무제한 증가를 막는다. */
  maxKeys?: number;
}

interface Entry {
  failures: number;
  /** 마지막 실패 시각. */
  last: number;
  /** 이 시각까지 막힌다. 0 이면 안 막힘. */
  blockedUntil: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** 막혀 있다면 몇 초 뒤에 다시 되는지. */
  retryAfterSeconds: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: RateLimitOptions) {}

  /** 지금 이 키로 시도해도 되는지. 시도 자체를 세지는 않는다. */
  check(key: string, now: number = Date.now()): RateLimitVerdict {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };

    if (entry.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
      };
    }
    // 막힌 시간이 지났거나 조용한 기간이 충분히 길었으면 처음부터 다시 센다.
    if (entry.blockedUntil > 0 || now - entry.last > this.options.windowMs) {
      this.entries.delete(key);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 실패를 기록한다. 한도를 넘으면 그 키를 막는다. */
  fail(key: string, now: number = Date.now()): void {
    const existing = this.entries.get(key);
    const stale = existing && now - existing.last > this.options.windowMs;
    const failures = existing && !stale ? existing.failures + 1 : 1;

    this.entries.set(key, {
      failures,
      last: now,
      blockedUntil: failures >= this.options.limit ? now + this.options.blockMs : 0,
    });
    this.evict(now);
  }

  /** 성공했으니 기록을 지운다. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  /** 기억 중인 키 수 (테스트·점검용). */
  get size(): number {
    return this.entries.size;
  }

  /** 오래된 기록을 정리하고, 그래도 많으면 오래된 것부터 버린다. */
  private evict(now: number): void {
    const max = this.options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (this.entries.size <= max) return;

    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.last > this.options.windowMs) {
        this.entries.delete(key);
      }
    }
    // Map 은 넣은 순서를 지키므로 앞쪽이 가장 오래된 것이다.
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
