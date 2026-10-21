/**
 * 버전이 적힌 곳을 읽는다 — set-version·publish-release·check-sync 가 함께 쓴다.
 *
 * 버전은 여러 곳에 흩어져 있어(set-version.mjs 머리말) 읽는 쪽마다 목록을 따로 들면 한쪽만 어긋난다.
 */
import fs from 'node:fs';
import path from 'node:path';

/** package-lock.json 의 packages 중 버전을 맞추는 항목 ('' 는 루트). */
export const LOCK_PACKAGES = ['', 'app', 'server', 'shared', 'desktop'];

const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

/** 1.2.3 → 10203. minor·patch 는 99 까지. */
export function versionCodeOf(v) {
  const [major, minor, patch] = v.split('.').map(Number);
  if (minor > 99 || patch > 99) throw new Error('minor·patch 는 99 까지만 쓸 수 있습니다 (versionCode 계산).');
  return major * 10000 + minor * 100 + patch;
}

/** package.json 5곳과 app/app.json 의 version → { 파일: 값 }. 기준은 루트 package.json. */
export function readVersions(root) {
  return {
    'package.json': readJson(root, 'package.json').version,
    'app/package.json': readJson(root, 'app/package.json').version,
    'server/package.json': readJson(root, 'server/package.json').version,
    'shared/package.json': readJson(root, 'shared/package.json').version,
    'desktop/package.json': readJson(root, 'desktop/package.json').version,
    'app/app.json': readJson(root, 'app/app.json').expo.version,
  };
}

/** package-lock.json 에 적힌 버전 → { 'package-lock.json[항목]': 값 }. */
export function readLockVersions(root) {
  const lock = readJson(root, 'package-lock.json');
  const out = { 'package-lock.json': lock.version };
  for (const key of LOCK_PACKAGES) out[`package-lock.json packages["${key}"]`] = lock.packages?.[key]?.version;
  return out;
}

/** app/app.json 의 android.versionCode. */
export function readVersionCode(root) {
  return readJson(root, 'app/app.json').expo.android?.versionCode;
}

/** 기대 버전과 다른 곳 → [[파일, 값], …]. */
export function mismatchedVersions(versions, expected) {
  return Object.entries(versions).filter(([, v]) => v !== expected);
}
