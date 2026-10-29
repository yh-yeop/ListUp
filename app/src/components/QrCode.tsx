import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { View } from 'react-native';

/** 스캐너는 밝은 바탕의 어두운 칸을 기대한다 — 다크 모드에서도 테마 색을 쓰지 않는다. */
const DARK = '#111111';
const LIGHT = '#ffffff';
/** 가장자리 여백(칸 수). 표준은 4칸. */
const QUIET = 4;

/**
 * QR 코드. 네이티브 의존성(SVG·캔버스) 없이 View 로 그린다 — 한 줄에서 이어지는 어두운 칸은 하나로 합쳐
 * 그리는 수를 줄인다. 초대 링크처럼 짧은 주소면 한 변이 30~40칸 남짓이다.
 */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const runs: { row: number; start: number; length: number }[][] = [];
    for (let r = 0; r < count; r += 1) {
      const line: { row: number; start: number; length: number }[] = [];
      let c = 0;
      while (c < count) {
        if (!qr.isDark(r, c)) {
          c += 1;
          continue;
        }
        const start = c;
        while (c < count && qr.isDark(r, c)) c += 1;
        line.push({ row: r, start, length: c - start });
      }
      runs.push(line);
    }
    return { count, runs };
  }, [value]);

  // 칸 크기를 정수로 — 소수면 줄 사이에 머리카락 같은 틈이 생겨 스캔이 흔들린다.
  const cell = Math.max(2, Math.floor(size / (rows.count + QUIET * 2)));
  const side = cell * (rows.count + QUIET * 2);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: side, height: side, backgroundColor: LIGHT, position: 'relative' }}
    >
      {rows.runs.flat().map((run) => (
        <View
          key={`${run.row}:${run.start}`}
          style={{
            position: 'absolute',
            left: (run.start + QUIET) * cell,
            top: (run.row + QUIET) * cell,
            width: run.length * cell,
            height: cell,
            backgroundColor: DARK,
          }}
        />
      ))}
    </View>
  );
}
