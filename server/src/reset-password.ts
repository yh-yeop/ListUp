/**
 * 비밀번호 재설정 코드 발급 — 서버를 돌리는 사람이 쓴다.
 *
 *   npm run reset-password -- <이메일>
 *
 * 나온 코드를 본인에게 전해 주면, 앱 로그인 화면의 "비밀번호를 잊었나요?" 에서 새 비밀번호를 정한다.
 * 코드는 30분 뒤 만료되고 한 번만 쓸 수 있다. 서버가 켜져 있어도 된다.
 */
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { normalizeEmail } from './lib/auth.ts';
import { issueResetCode } from './services/password-reset.ts';

const email = normalizeEmail(process.argv[2] ?? '');
if (!email) {
  console.error('사용법: npm run reset-password -- <이메일>');
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.dbPath);
try {
  const issued = issueResetCode(db, email);
  if (!issued) {
    console.error(`이 서버에 ${email} 계정이 없습니다.`);
    process.exit(1);
  }
  const until = new Date(issued.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n  재설정 코드: ${issued.code}`);
  console.log(`  ${email} · ${until} 까지 한 번 쓸 수 있습니다.\n`);
  console.log('본인에게 코드를 전해 주세요. 앱 로그인 화면의 "비밀번호를 잊었나요?" 에서 새 비밀번호를 정합니다.');
  console.log('새 비밀번호를 정하면 그 계정의 다른 기기 로그인은 모두 끊깁니다.');
} finally {
  db.close();
}
