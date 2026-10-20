/**
 * 안드로이드 서명 키 지키기 — build-android·publish-release 가 같이 쓴다.
 *
 * 폰은 **처음 설치한 APK 와 같은 키로 서명된 APK 만** 덮어 설치한다. 다른 키로 서명하면 앱을 지우고 새로 깔아야
 * 하고, 그러면 폰에 저장된 서버 목록과 로그인이 사라진다. 키는 저장소 밖(~/.listup)에 있어서 PC 를 옮기거나
 * 지우면 없어지기 쉽고, 예전 빌드 스크립트는 키가 없으면 조용히 새로 만들었다.
 *
 * 그래서 정식 키의 **인증서 지문**(공개해도 되는 값)을 저장소에 고정해 둔다 → PIN_FILE.
 *   - 지문이 고정돼 있으면 키가 없을 때 새로 만들지 않고 멈춘다. 다른 키여도 멈춘다.
 *   - 빌드한 APK 의 서명도 다시 읽어 지문과 견준다.
 *   - 지문이 없을 때(처음·포크)는 `--new-key` 를 줘야만 키를 만들고, 그 키의 지문을 고정한다.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** 저장소에 커밋하는 정식 서명 인증서 지문. */
export const PIN_FILE = path.join(ROOT, 'app', 'android-signing-cert.json');

/** 서명 설정(비밀번호 포함) — 저장소 밖. 옆에 keystore 가 있다. */
export const SIGNING_FILE =
  process.env.LISTUP_ANDROID_SIGNING ?? path.join(os.homedir(), '.listup', 'android-signing.json');

/** `AB:cd:…` 이든 `abcd…` 든 소문자 16진수 하나로. */
export function normalizeFingerprint(value) {
  return String(value).replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/** 사람이 읽기 좋게 `AB:CD:…`. */
export function formatFingerprint(hex) {
  return normalizeFingerprint(hex).toUpperCase().match(/.{2}/g)?.join(':') ?? '';
}

/** 고정된 지문. 없으면 null. */
export function readPin() {
  if (!fs.existsSync(PIN_FILE)) return null;
  const pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  const sha256 = normalizeFingerprint(pin.sha256 ?? '');
  if (sha256.length !== 64) throw new Error(`${path.relative(ROOT, PIN_FILE)} 의 sha256 이 올바르지 않습니다.`);
  return { ...pin, sha256 };
}

export function writePin({ sha256, from }) {
  const pin = {
    // 이 파일은 지우거나 바꾸지 않는다 — 바꾸면 이미 설치한 폰이 업데이트를 받지 못한다.
    note: '안드로이드 APK 정식 서명 인증서의 SHA-256 지문. 공개해도 되는 값이다. scripts/android-signing.mjs 참고.',
    sha256: formatFingerprint(sha256),
    from,
    pinnedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
}

/** 서명 설정을 읽는다. 없으면 null. 설정과 키 파일 중 하나만 있으면 오류. */
export function readSigning() {
  const dir = path.dirname(SIGNING_FILE);
  const defaultStore = path.join(dir, 'listup-release.keystore');
  if (!fs.existsSync(SIGNING_FILE)) {
    if (fs.existsSync(defaultStore)) throw new Error(`키 파일은 있는데 서명 설정이 없습니다: ${SIGNING_FILE}`);
    return null;
  }
  const signing = JSON.parse(fs.readFileSync(SIGNING_FILE, 'utf8'));
  const storeFile = path.resolve(dir, signing.storeFile);
  if (!fs.existsSync(storeFile)) throw new Error(`서명 설정은 있는데 키 파일이 없습니다: ${storeFile}`);
  return { ...signing, storeFile };
}

/** keystore 안 키의 인증서 지문. 출력 문구(언어마다 다르다)를 읽지 않고 인증서를 꺼내 직접 해시한다. */
export function keystoreFingerprint(javaHome, signing) {
  const keytool = path.join(javaHome, 'bin', isWindows ? 'keytool.exe' : 'keytool');
  const out = path.join(os.tmpdir(), `listup-cert-${process.pid}-${Date.now()}.der`);
  try {
    const result = spawnSync(
      keytool,
      [
        '-exportcert',
        '-keystore', signing.storeFile,
        '-storepass', signing.storePassword,
        '-alias', signing.keyAlias,
        '-file', out,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0 || !fs.existsSync(out)) {
      throw new Error(`키에서 인증서를 꺼내지 못했습니다 (비밀번호·별칭 확인).\n${result.stderr || result.stdout}`);
    }
    return crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Android SDK 의 가장 새 build-tools 에 있는 apksigner. */
function findApksigner(androidHome) {
  const dir = path.join(androidHome, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  const versions = fs
    .readdirSync(dir)
    .filter((name) => /^\d+(\.\d+)*/.test(name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const version of versions) {
    const tool = path.join(dir, version, isWindows ? 'apksigner.bat' : 'apksigner');
    if (fs.existsSync(tool)) return tool;
  }
  return null;
}

/** APK 서명 인증서의 지문들(보통 하나). javaHome 은 apksigner 를 돌릴 JDK. */
export function apkFingerprints(apk, { androidHome, javaHome }) {
  const apksigner = findApksigner(androidHome);
  if (!apksigner) throw new Error(`apksigner 를 찾지 못했습니다 (${path.join(androidHome, 'build-tools')}).`);
  const env = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
  const args = ['verify', '--print-certs', apk];
  const result = isWindows
    ? // .bat 는 shell 없이 못 부른다. 경로에 공백이 있을 수 있어 따옴표로 감싼 명령줄을 그대로 넘긴다.
      spawnSync('cmd.exe', ['/d', '/s', '/c', `""${apksigner}" ${args.map((a) => `"${a}"`).join(' ')}"`], {
        encoding: 'utf8',
        env,
        windowsVerbatimArguments: true,
      })
    : spawnSync(apksigner, args, { encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`APK 서명을 읽지 못했습니다: ${apk}\n${result.stderr || result.stdout}`);
  const digests = [...result.stdout.matchAll(/certificate SHA-256 digest:\s*([0-9a-f:]+)/gi)].map((m) =>
    normalizeFingerprint(m[1]),
  );
  if (digests.length === 0) throw new Error(`APK 에서 서명 인증서를 찾지 못했습니다: ${apk}`);
  return [...new Set(digests)];
}

/** 키가 없을 때·다를 때 보여 줄 설명. */
export function missingKeyMessage(pin) {
  return (
    `안드로이드 서명 키가 없습니다: ${SIGNING_FILE}\n\n` +
    `이 앱은 이미 이 키로 서명해 내보냈습니다(지문 ${formatFingerprint(pin.sha256)}, ${pin.from}).\n` +
    '새 키로 빌드하면 폰의 기존 앱 위에 덮어 설치되지 않습니다 — 지우고 다시 깔아야 하고, 그러면 폰에 저장된\n' +
    '서버 목록과 로그인이 사라집니다. 그래서 새 키를 만들지 않고 멈춥니다.\n\n' +
    '지난 릴리즈를 만든 PC 나 백업에서 다음 두 파일을 옮겨 오세요:\n' +
    `  ${path.join(path.dirname(SIGNING_FILE), 'listup-release.keystore')}\n` +
    `  ${SIGNING_FILE}`
  );
}
