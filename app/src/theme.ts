import { Platform, useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  /** warning 배경 위에 올리는 글자색 (배지 숫자 등). */
  warningText: string;
  warningSoft: string;
}

const light: Palette = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surfaceAlt: '#f0f2f5',
  border: '#e3e6ea',
  text: '#16191d',
  // textMuted/textFaint 는 bg·surface·surfaceAlt 위에서 WCAG AA(4.5:1) 를 넘긴다.
  textMuted: '#535b65',
  textFaint: '#686e76',
  accent: '#2f6df6',
  accentText: '#ffffff',
  accentSoft: '#e8f0ff',
  danger: '#d4363c',
  dangerSoft: '#fdeaea',
  success: '#12805c',
  successSoft: '#e3f5ee',
  warning: '#996100',
  warningText: '#ffffff',
  warningSoft: '#fdf1dd',
};

const dark: Palette = {
  bg: '#101216',
  surface: '#181b21',
  surfaceAlt: '#20242b',
  border: '#282d36',
  text: '#f2f4f7',
  textMuted: '#a4acb8',
  textFaint: '#838b96',
  accent: '#5b8dff',
  accentText: '#0d1117',
  accentSoft: '#1c2740',
  danger: '#ff6b70',
  dangerSoft: '#3a1f21',
  success: '#3fca9a',
  successSoft: '#12312a',
  warning: '#e5a54a',
  warningText: '#0d1117',
  warningSoft: '#33280f',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 28,
} as const;

/** 여러 줄 코드/경로 표시에 쓰는 고정폭 글꼴. */
export const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

export interface Theme {
  colors: Palette;
  dark: boolean;
}

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { colors: isDark ? dark : light, dark: isDark };
}

/** 화면 최대 너비 — PC 브라우저에서 한 줄이 지나치게 길어지지 않게 한다. */
export const CONTENT_MAX_WIDTH = 860;
