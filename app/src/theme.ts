import { Platform, useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
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
  warningSoft: string;
  overlay: string;
}

const light: Palette = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surfaceAlt: '#f0f2f5',
  border: '#e3e6ea',
  borderStrong: '#cdd2d9',
  text: '#16191d',
  textMuted: '#5c646e',
  textFaint: '#8b939d',
  accent: '#2f6df6',
  accentText: '#ffffff',
  accentSoft: '#e8f0ff',
  danger: '#d4363c',
  dangerSoft: '#fdeaea',
  success: '#12805c',
  successSoft: '#e3f5ee',
  warning: '#a76a00',
  warningSoft: '#fdf1dd',
  overlay: 'rgba(15, 18, 22, 0.45)',
};

const dark: Palette = {
  bg: '#101216',
  surface: '#181b21',
  surfaceAlt: '#20242b',
  border: '#282d36',
  borderStrong: '#3a414c',
  text: '#f2f4f7',
  textMuted: '#a4acb8',
  textFaint: '#727b88',
  accent: '#5b8dff',
  accentText: '#0d1117',
  accentSoft: '#1c2740',
  danger: '#ff6b70',
  dangerSoft: '#3a1f21',
  success: '#3fca9a',
  successSoft: '#12312a',
  warning: '#e5a54a',
  warningSoft: '#33280f',
  overlay: 'rgba(0, 0, 0, 0.6)',
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
