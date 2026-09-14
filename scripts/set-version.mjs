/**
 * 버전을 한 번에 바꾼다.
 *
 *   npm run version:set -- 1.1.0
 *
 * 버전은 여러 곳에 흩어져 있어 하나만 바꾸면 어긋난다.
 *   - package.json (루트·app·server·shared) 와 package-lock.json
 *   - server/package.json 은 /api/health 가 알려주는 서버 버전이다
 *   - app/app.json 의 version — 앱이 보여주고, 업데이트 확인에서 GitHub 릴리즈와 견주는 값
 *   - app/app.json 의 android.versionCode — 안드로이드는 이 숫자가 올라가야 업데이트 설치를 허락한다
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('사용법: npm run version:set -- <major.minor.patch>   (예: 1.1.0)');
  process.exit(1);
}

/** 1.2.3 → 10203. minor·patch 는 99 까지. */
function versionCodeOf(v) {
  const [major, minor, patch] = v.split('.').map(Number);
  if (minor > 99 || patch > 99) throw new Error('minor·patch 는 99 까지만 쓸 수 있습니다 (versionCode 계산).');
  return major * 10000 + minor * 100 + patch;
}

function updateJson(relative, change) {
  const file = path.join(ROOT, relative);
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  change(data);
  // 원래 파일의 들여쓰기(2칸)와 끝 줄바꿈을 지킨다.
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`);
  console.log(`  ${relative}`);
}

const code = versionCodeOf(version);
console.log(`버전을 ${version} (versionCode ${code}) 으로 바꿉니다.`);

for (const pkg of ['package.json', 'app/package.json', 'server/package.json', 'shared/package.json']) {
  updateJson(pkg, (data) => {
    data.version = version;
  });
}
updateJson('package-lock.json', (lock) => {
  lock.version = version;
  for (const key of ['', 'app', 'server', 'shared']) {
    if (lock.packages?.[key]) lock.packages[key].version = version;
  }
});
updateJson('app/app.json', (config) => {
  config.expo.version = version;
  config.expo.android = { ...config.expo.android, versionCode: code };
});
