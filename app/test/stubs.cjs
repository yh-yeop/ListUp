/** React Native·Expo 가짜. 단위 테스트가 닿는 것만 — 기기 파일 같은 것은 불리면 바로 드러나게 던진다. */
const memory = new Map();

class Unavailable {
  constructor() {
    throw new Error('단위 테스트에서는 기기 파일을 쓸 수 없습니다.');
  }
}

const stub = {
  Platform: { OS: 'web', select: (options) => options.web ?? options.default },
  Alert: { alert: () => {} },
  Linking: { openURL: async () => {} },
  AccessibilityInfo: { announceForAccessibility: () => {} },
  File: Unavailable,
  Directory: Unavailable,
  Paths: {},
  // expo-constants (default)
  expoConfig: null,
  expoGoConfig: null,
  // AsyncStorage (default)
  getItem: async (key) => memory.get(key) ?? null,
  setItem: async (key, value) => void memory.set(key, value),
  removeItem: async (key) => void memory.delete(key),
};
stub.default = stub;
module.exports = stub;
