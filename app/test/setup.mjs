/**
 * 앱 단위 테스트 준비 — React Native·Expo 모듈을 Node 에서 불러올 수 있는 가짜(stubs.cjs)로 바꾼다.
 * 화면이 아니라 순수한 로직(전송·비교·토스트·서버 주소 등)만 시험하므로 가짜는 비어 있어도 된다.
 *
 *   node --import tsx --import ./test/setup.mjs --test test/*.test.ts
 *
 * tsx 는 앱의 .ts 를 CommonJS 로 불러오므로 import·require 를 함께 잡는 registerHooks 를 쓴다.
 */
import { registerHooks } from 'node:module';

globalThis.__DEV__ = true;

/** 이름이 react-native·expo 로 시작하는 모듈과 AsyncStorage. */
const STUBBED = [/^react-native$/, /^expo(-[a-z-]+)?(\/.*)?$/, /^@react-native-async-storage\//];
const STUB_URL = new URL('./stubs.cjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBBED.some((pattern) => pattern.test(specifier))) {
      return { url: STUB_URL, format: 'commonjs', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
