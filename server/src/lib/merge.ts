/**
 * 텍스트 3-way 병합 (diff3). 제안 당시 원본(base), 지금 저장소(theirs), 제안(mine) 세 판을 줄 단위로 견줘,
 * 두 쪽이 서로 다른 곳을 고쳤으면 둘 다 살려 합친다. 같은 곳을 다르게 고쳤으면 합치지 못한다(null).
 *
 * 줄 맞추기는 LCS. 앞뒤의 같은 줄을 먼저 떼어 내므로 보통의 문서 수정은 가볍다. 가운데가 너무 크면(표가
 * MAX_CELLS 를 넘으면) 합치지 않는다 — 자동 병합은 편의일 뿐이고 실패해도 사람이 고를 수 있다.
 */

const MAX_CELLS = 4_000_000;

/** 줄 끝(\n)을 남긴 채 줄로 나눈다 — 합친 뒤 줄 끝 모양(CRLF 등)이 그대로 남게. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * a 의 각 줄이 b 의 몇 번째 줄과 짝인지(LCS). 짝이 없으면 -1. 표가 너무 크면 null.
 */
export function matchLines(a: string[], b: string[]): number[] | null {
  const result = new Array<number>(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    result[start] = start;
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    result[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return result;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // lcs[i][j] = a[start+i..endA) 와 b[start+j..endB) 의 LCS 길이 (뒤에서부터 채운다).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      result[start + i] = start + j;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, index) => line === y[index]);

export type MergeResult = { ok: true; text: string } | { ok: false; reason: 'conflict' | 'too-large' };

/** base 를 기준으로 theirs 와 mine 의 고친 것을 합친다. */
export function merge3(base: string, theirs: string, mine: string): MergeResult {
  const o = splitLines(base);
  const a = splitLines(theirs);
  const b = splitLines(mine);
  const ma = matchLines(o, a);
  const mb = matchLines(o, b);
  if (!ma || !mb) return { ok: false, reason: 'too-large' };

  const out: string[] = [];
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    // 세 판 모두에 그대로 남은 다음 줄(안정한 자리)을 찾는다.
    let k = io;
    while (k < o.length && !(ma[k] >= ia && mb[k] >= ib)) k += 1;
    const stable = k < o.length;
    if (stable && k === io && ma[k] === ia && mb[k] === ib) {
      out.push(o[k]);
      io += 1;
      ia += 1;
      ib += 1;
      continue;
    }
    // 그 앞까지가 고친 덩어리다.
    const chunkO = o.slice(io, k);
    const chunkA = a.slice(ia, stable ? ma[k] : a.length);
    const chunkB = b.slice(ib, stable ? mb[k] : b.length);
    if (same(chunkA, chunkO)) out.push(...chunkB);
    else if (same(chunkB, chunkO)) out.push(...chunkA);
    else if (same(chunkA, chunkB)) out.push(...chunkA);
    else return { ok: false, reason: 'conflict' };
    if (!stable) break;
    io = k;
    ia = ma[k];
    ib = mb[k];
  }
  return { ok: true, text: out.join('') };
}

/** 자동 병합을 해 볼 만한 텍스트인지 — 크기, NUL 바이트, 올바른 UTF-8. */
export const MAX_MERGE_BYTES = 1024 * 1024;

export function decodeText(buffer: Buffer): string | null {
  if (buffer.length > MAX_MERGE_BYTES || buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
