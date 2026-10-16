/** React Native·Expo 가짜. 단위 테스트가 닿는 것만 — 나머지는 불리면 바로 드러나게 던진다. */
export const Platform = { OS: 'web', select: (options) => options.web ?? options.default };
export const Alert = { alert: () => {} };
export const Linking = { openURL: async () => {} };
export const AccessibilityInfo = { announceForAccessibility: () => {} };

const memory = new Map();
const AsyncStorage = {
  getItem: async (key) => memory.get(key) ?? null,
  setItem: async (key, value) => void memory.set(key, value),
  removeItem: async (key) => void memory.delete(key),
};

class Unavailable {
  constructor() {
    throw new Error('단위 테스트에서는 기기 파일을 쓸 수 없습니다.');
  }
}
export const File = Unavailable;
export const Directory = Unavailable;
export const Paths = {};

const Constants = { expoConfig: null, expoGoConfig: null };
export default new Proxy(
  { ...AsyncStorage, ...Constants },
  { get: (target, key) => (key in target ? target[key] : undefined) },
);
