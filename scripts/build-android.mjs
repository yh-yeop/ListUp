/**
 * 안드로이드 설치형 클라이언트(APK)를 만든다.
 *
 *   npm run build:android
 *
 * 하는 일: 도구 확인 → `expo prebuild`(android/ 를 app.json 에서 새로 만듦) → 릴리스 서명으로
 * `gradlew assembleRelease` → release/listup-<버전>-android.apk.
 *
 * 설치형 클라이언트는 서버와 무관하게 켜지고, 서버 목록에서 들어갈 서버를 고른다(클라이언트 모드).
 *
 * **서명 키.** 저장소 밖(~/.listup/android-signing.json 과 옆의 keystore)에 둔다. 이 키를 잃으면 **같은 앱으로
 * 업데이트 설치가 안 된다** — 지우고 다시 깔아야 하고 그러면 폰에 저장된 서버 목록과 로그인이 사라진다. 백업해 둘 것.
 * 다른 위치는 LISTUP_ANDROID_SIGNING 으로. 정식 키의 지문은 app/android-signing-cert.json 에 고정돼 있어, 키가
 * 없거나 다르면 새로 만들지 않고 멈춘다(scripts/android-signing.mjs).
 *
 *   npm run build:android -- --new-key          지문이 고정되지 않은 처음 한 번(포크 등)만 — 키를 만들고 지문을 고정
 *   npm run build:android -- --pin-from <apk>   이미 내보낸 APK 의 서명으로 지문을 고정만 하고 끝낸다
 *   npm run build:android -- --check-key        빌드하지 않고 키가 정식 키와 같은지만 본다(옮겨 온 키 확인)
 *
 * 환경변수
 *   JAVA_HOME          JDK 17 (없으면 기본 설치 위치에서 찾는다)
 *   ANDROID_HOME       Android SDK (없으면 %LOCALAPPDATA%\Android\Sdk)
 *   LISTUP_ANDROID_ABIS  빌드할 CPU 종류 (기본 arm64-v8a — 요즘 폰. 쉼표로 여러 개)
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIN_FILE,
  SIGNING_FILE,
  apkFingerprints,
  formatFingerprint,
  keystoreFingerprint,
  missingKeyMessage,
  readPin,
  readSigning,
  writePin,
} from './android-signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const ANDROID_DIR = path.join(APP_DIR, 'android');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT = path.join(ROOT, 'release', `listup-${VERSION}-android.apk`);
const isWindows = process.platform === 'win32';

const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n${m}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 0. 버전 — 앱은 app.json 의 버전으로 GitHub 릴리즈와 견주고, 안드로이드는 versionCode 가 올라가야
//    업데이트 설치를 허락한다. 어긋난 채 빌드하면 업데이트 제안과 설치가 틀어진다.
// ---------------------------------------------------------------------------
{
  const expo = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8')).expo;
  const [major, minor, patch] = VERSION.split('.').map(Number);
  const expectedCode = major * 10000 + minor * 100 + patch;
  if (expo.version !== VERSION || expo.android?.versionCode !== expectedCode) {
    fail(
      `버전이 어긋납니다: package.json ${VERSION}, app.json ${expo.version} (versionCode ${expo.android?.versionCode}).\n` +
        `npm run version:set -- ${VERSION} 로 맞추세요.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. 도구 — JDK 17 과 Android SDK
// ---------------------------------------------------------------------------
/** JDK 17 인지. java -version 은 표준오류로 출력한다. */
function isJdk17(home) {
  const java = path.join(home, 'bin', isWindows ? 'java.exe' : 'java');
  if (!fs.existsSync(java)) return false;
  const out = spawnSync(java, ['-version'], { encoding: 'utf8' });
  return /version "17\./.test(`${out.stderr ?? ''}${out.stdout ?? ''}`);
}

/**
 * JDK 17 을 찾는다. JAVA_HOME 이 다른 버전(예전에 깐 JDK 8 등)을 가리키는 PC 가 흔하고, 방금 설치해
 * 환경변수가 아직 반영되지 않은 창도 있으므로, JAVA_HOME 이 17 이 아니면 기본 설치 위치에서 찾는다.
 */
function findJavaHome() {
  const candidates = process.env.JAVA_HOME ? [process.env.JAVA_HOME] : [];
  const bases = isWindows
    ? ['C:\\Program Files\\Microsoft', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((n) => n.includes('17'))) {
      const home = path.join(base, name);
      const macHome = path.join(home, 'Contents', 'Home');
      candidates.push(fs.existsSync(macHome) ? macHome : home);
    }
  }
  return candidates.find(isJdk17) ?? null;
}

function findAndroidHome() {
  const fromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const guess = isWindows
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
    : path.join(os.homedir(), 'Android', 'Sdk');
  return fs.existsSync(guess) ? guess : null;
}

const javaHome = findJavaHome();
if (!javaHome) {
  fail('JDK 17 을 찾지 못했습니다. 설치한 뒤 JAVA_HOME 을 지정하세요 (winget install Microsoft.OpenJDK.17).');
}

const androidHome = findAndroidHome();
if (!androidHome) fail('Android SDK 를 찾지 못했습니다. 설치한 뒤 ANDROID_HOME 을 지정하세요.');

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome };
say(`JDK: ${javaHome}`);
say(`Android SDK: ${androidHome}\n`);

// ---------------------------------------------------------------------------
// 2. 서명 키 — 저장소 밖에. 고정된 지문과 같은 키만 쓴다(scripts/android-signing.mjs).
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const relative = (file) => path.relative(ROOT, file);

// 이미 내보낸 APK 로 지문만 고정하고 끝낸다 — 키가 없는 PC 에서도 할 수 있다.
const pinFromIndex = argv.indexOf('--pin-from');
if (pinFromIndex !== -1) {
  const apk = argv[pinFromIndex + 1] ? path.resolve(argv[pinFromIndex + 1]) : null;
  if (!apk || !fs.existsSync(apk)) fail('사용법: npm run build:android -- --pin-from <내보낸 APK 경로>');
  let digests;
  try {
    digests = apkFingerprints(apk, { androidHome, javaHome });
  } catch (err) {
    fail(err.message);
  }
  if (digests.length !== 1) fail(`서명 인증서가 ${digests.length}개인 APK 입니다. 하나인 APK 로 고정하세요.`);
  const pinned = readPin();
  if (pinned && pinned.sha256 !== digests[0]) {
    fail(
      `이미 다른 지문이 고정돼 있습니다.\n  고정: ${formatFingerprint(pinned.sha256)}\n  APK : ${formatFingerprint(digests[0])}\n` +
        `정말 바꾸려면 ${relative(PIN_FILE)} 를 지우고 다시 하세요 — 이미 설치한 폰은 업데이트를 받지 못하게 됩니다.`,
    );
  }
  writePin({ sha256: digests[0], from: path.basename(apk) });
  say(`지문을 고정했습니다: ${formatFingerprint(digests[0])}`);
  say(`  ${relative(PIN_FILE)} 를 커밋하세요.`);
  process.exit(0);
}

function createSigning() {
  const dir = path.dirname(SIGNING_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'listup-release.keystore');
  // PKCS12 는 저장소와 키의 비밀번호가 같아야 한다.
  const password = crypto.randomBytes(24).toString('base64url');
  const keyAlias = 'listup';
  const keytool = path.join(javaHome, 'bin', isWindows ? 'keytool.exe' : 'keytool');
  const made = spawnSync(
    keytool,
    [
      '-genkeypair', '-v',
      '-storetype', 'PKCS12',
      '-keystore', storeFile,
      '-alias', keyAlias,
      '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000',
      '-storepass', password, '-keypass', password,
      '-dname', 'CN=ListUp, O=ListUp',
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) fail(`서명 키를 만들지 못했습니다.\n${made.stderr}`);
  const signing = { storeFile: path.basename(storeFile), storePassword: password, keyAlias, keyPassword: password };
  fs.writeFileSync(SIGNING_FILE, `${JSON.stringify(signing, null, 2)}\n`);
  say('릴리스 서명 키를 새로 만들었습니다:');
  say(`  ${storeFile}`);
  say(`  ${SIGNING_FILE}`);
  say('  이 두 파일을 잃으면 같은 앱으로 업데이트 설치가 안 됩니다. 저장소 밖에 백업해 두세요.\n');
  return { ...signing, storeFile };
}

let pin;
let signing;
try {
  pin = readPin();
  signing = readSigning();
} catch (err) {
  fail(err.message);
}

if (!signing) {
  // 지문이 고정돼 있다 = 이미 그 키로 내보냈다. 새 키를 만들면 덮어 설치가 깨지므로 절대 만들지 않는다.
  if (pin) fail(missingKeyMessage(pin));
  if (!argv.includes('--new-key')) {
    fail(
      `안드로이드 서명 키가 없습니다: ${SIGNING_FILE}\n\n` +
        '이미 이 앱을 내보낸 적이 있다면 그때 쓴 키를 옮겨 오세요 — 새 키로 서명한 APK 는 폰의 기존 앱 위에\n' +
        '덮어 설치되지 않습니다. 이 앱을 처음 내보내는 것이라면 새 키를 만들겠다고 밝혀 주세요:\n' +
        '  npm run build:android -- --new-key',
    );
  }
  signing = createSigning();
}

// 쓰려는 키가 고정된 정식 키인지. 고정된 지문이 없으면(처음) 이 키를 정식 키로 고정한다.
let keyFingerprint;
try {
  keyFingerprint = keystoreFingerprint(javaHome, signing);
} catch (err) {
  fail(err.message);
}
if (pin && pin.sha256 !== keyFingerprint) {
  fail(
    `서명 키가 정식 키와 다릅니다.\n  정식: ${formatFingerprint(pin.sha256)} (${pin.from})\n  지금: ${formatFingerprint(keyFingerprint)}\n` +
      `  ${SIGNING_FILE}\n\n이 키로 빌드하면 폰의 기존 앱 위에 덮어 설치되지 않습니다. 지난 릴리즈의 키를 옮겨 오세요.`,
  );
}
if (argv.includes('--check-key')) {
  // 키만 확인하고 끝낸다 — 옮겨 온 키가 맞는지 볼 때.
  say(`서명 키: ${formatFingerprint(keyFingerprint)}`);
  say(pin ? `정식 키와 같습니다 (${pin.from}).` : `정식 지문이 아직 고정돼 있지 않습니다 (${relative(PIN_FILE)}).`);
  process.exit(0);
}
if (!pin) {
  writePin({ sha256: keyFingerprint, from: `v${VERSION} 빌드에 쓴 키` });
  pin = readPin();
  say(`이 키를 정식 서명 키로 고정했습니다: ${formatFingerprint(keyFingerprint)}`);
  say(`  ${relative(PIN_FILE)} 를 커밋하세요.\n`);
} else {
  say(`서명 키: 정식 키와 같습니다 (${formatFingerprint(keyFingerprint).slice(0, 23)}…)\n`);
}

// ---------------------------------------------------------------------------
// 3. 네이티브 프로젝트 — app.json 에서 매번 새로 만든다 (커밋하지 않는다)
// ---------------------------------------------------------------------------
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 실패 (${code})`))));
  });
}

const expoCli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
const appPackageJson = path.join(APP_DIR, 'package.json');
// prebuild 는 android/ 를 처음 만들 때 package.json 의 android·ios 스크립트를 `expo run:*` 으로
// 바꾼다. android/ 를 커밋하지 않고 매번 새로 만드는 이 프로젝트에는 필요 없는 변경이라 되돌린다.
const appPackageBefore = fs.readFileSync(appPackageJson);
say('android/ 를 새로 만듭니다 (expo prebuild)…');
try {
  await run(process.execPath, [expoCli, 'prebuild', '--platform', 'android', '--clean', '--no-install'], {
    cwd: APP_DIR,
    // 대화형 질문(git 상태 경고 등)을 건너뛴다.
    env: { ...env, CI: '1', EXPO_NO_GIT_STATUS: '1' },
  });
} finally {
  fs.writeFileSync(appPackageJson, appPackageBefore);
}

// ---------------------------------------------------------------------------
// 4. 빌드 — 릴리스 서명은 gradle 에 주입한다(android/ 를 고치지 않고)
// ---------------------------------------------------------------------------
const abis = process.env.LISTUP_ANDROID_ABIS ?? 'arm64-v8a';
const gradleArgs = [
  'assembleRelease',
  `-PreactNativeArchitectures=${abis}`,
  `-Pandroid.injected.signing.store.file=${signing.storeFile}`,
  `-Pandroid.injected.signing.store.password=${signing.storePassword}`,
  `-Pandroid.injected.signing.key.alias=${signing.keyAlias}`,
  `-Pandroid.injected.signing.key.password=${signing.keyPassword}`,
];
say(`\nAPK 를 빌드합니다 (${abis}). 처음에는 gradle 과 의존성을 받느라 오래 걸립니다…`);
if (isWindows) {
  // .bat 는 shell 없이 spawn 할 수 없어 cmd 로 부른다. 현재 폴더를 실행 파일 검색에서 빼는 설정
  // (NoDefaultCurrentDirectoryInExePath)이 켜진 환경이 있어 절대 경로로 부르고, 경로의 공백에
  // 대비해 따옴표로 감싼 명령줄을 그대로 넘긴다. gradle 인자에는 공백·따옴표가 없다.
  const gradlew = path.join(ANDROID_DIR, 'gradlew.bat');
  const commandLine = `"${gradlew}" ${gradleArgs.join(' ')}`;
  await run('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    cwd: ANDROID_DIR,
    windowsVerbatimArguments: true,
  });
} else {
  await run('./gradlew', gradleArgs, { cwd: ANDROID_DIR });
}

// ---------------------------------------------------------------------------
// 5. 결과
// ---------------------------------------------------------------------------
const built = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(built)) fail(`빌드는 끝났는데 APK 가 없습니다: ${built}`);
// 빌드한 APK 가 정말 정식 키로 서명됐는지 다시 읽어 본다 — gradle 설정이 키를 무시하면(디버그 키 등) 여기서 걸린다.
try {
  const digests = apkFingerprints(built, { androidHome, javaHome });
  if (digests.length !== 1 || digests[0] !== pin.sha256) {
    fail(
      `빌드한 APK 의 서명이 정식 키와 다릅니다 — 내보내지 않습니다.\n  정식: ${formatFingerprint(pin.sha256)}\n` +
        `  APK : ${digests.map(formatFingerprint).join(', ')}`,
    );
  }
} catch (err) {
  fail(err.message);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(built, OUT);
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
say(`\n완료: ${OUT} (${mb}MB)`);
say('폰에서 이 파일을 열어 설치하세요. "출처를 알 수 없는 앱" 설치를 허용해야 할 수 있습니다.');
