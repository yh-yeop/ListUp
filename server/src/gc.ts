/**
 * 참조되지 않는 blob 을 한 번 정리한다.
 *
 *   npm run gc              # 기본 유예(LISTUP_GC_MIN_AGE_HOURS, 기본 24시간)
 *   npm run gc -- 0         # 유예 없이 지금 참조 없는 것 전부 (주의: 업로드 중인 것도 지워질 수 있다)
 *
 * 서버가 켜져 있어도 돌릴 수 있다. 서버는 같은 정리를 주기적으로도 한다.
 */
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { collectGarbage } from './services/gc.ts';

const config = loadConfig();
const ctx = createContext(config);

const raw = process.argv[2];
const hours = raw === undefined ? null : Number(raw);
if (hours !== null && !Number.isFinite(hours)) {
  console.error(`유예 시간(시간 단위)이 올바르지 않습니다: ${raw}`);
  process.exit(1);
}
const minAgeMs = hours === null ? config.gcMinAgeMs : hours * 60 * 60 * 1000;

try {
  const result = await collectGarbage(ctx, minAgeMs);
  const mb = (result.freedBytes / 1024 / 1024).toFixed(1);
  console.log(
    `blob ${result.removed}개 삭제 (${mb}MB 회수), 고아 파일 ${result.orphanFiles}개 정리` +
      (result.failed > 0 ? `, 실패 ${result.failed}개(다음 실행에서 다시 시도)` : ''),
  );
} finally {
  ctx.close();
}
