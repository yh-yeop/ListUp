/**
 * 버전 비교 — 플랫폼 import 가 없는 순수 함수(app/test 가 node 에서 바로 불러 검사한다). 쓰는 곳은 updates.ts.
 */

/** `1.10.0` 과 `1.9.2` 처럼 숫자로 견준다. 앞의 `v` 와 `-beta` 같은 꼬리는 무시한다. a>b 면 양수. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
