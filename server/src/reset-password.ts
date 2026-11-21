/**
 * 비밀번호 재설정 코드 발급 — 서버를 돌리는 사람이 쓴다.
 *
 *   npm run reset-password -- <아이디>
 *   npm run reset-password -- --find <이름이나 아이디 일부>     아이디를 잊은 사람의 계정 찾기
 *
 * 나온 코드를 본인에게 전해 주면, 앱 로그인 화면의 "비밀번호를 잊었나요?" 에서 새 비밀번호를 정한다.
 * 코드는 30분 뒤 만료되고 한 번만 쓸 수 있다. 서버가 켜져 있어도 된다.
 */
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { normalizeLoginId } from './lib/auth.ts';
import { FIND_USERS_LIMIT, findUsers, issueResetCode } from './services/password-reset.ts';

const USAGE = '사용법: npm run reset-password -- <아이디>\n        npm run reset-password -- --find <이름이나 아이디 일부>';
const finding = process.argv[2] === '--find';
const query = finding ? process.argv.slice(3).join(' ').trim() : '';
const email = finding ? null : normalizeLoginId(process.argv[2] ?? '');
if (finding ? !query : !email) {
  console.error(USAGE);
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.dbPath);
try {
  if (finding) {
    const found = findUsers(db, query);
    if (found.length === 0) {
      console.error(`"${query}" 이(가) 이름이나 아이디에 들어간 계정이 없습니다.`);
      process.exit(1);
    }
    console.log('');
    for (const user of found.slice(0, FIND_USERS_LIMIT)) {
      const joined = new Date(user.createdAt).toLocaleDateString('ko-KR');
      console.log(`  ${user.loginId}  ·  ${user.displayName}  ·  ${joined} 가입`);
    }
    if (found.length > FIND_USERS_LIMIT) console.log(`  … 더 있습니다. 더 길게 적어 좁혀 주세요.`);
    console.log('\n본인인지 확인한 뒤 아이디를 알려 주세요. 비밀번호도 잊었다면: npm run reset-password -- <아이디>');
    process.exit(0);
  }
  const issued = issueResetCode(db, email!);
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
