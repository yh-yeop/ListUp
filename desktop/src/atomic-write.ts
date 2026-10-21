import fs from 'node:fs';
import path from 'node:path';

/**
 * 파일을 통째로 바꿔 쓴다 — 임시 파일에 쓰고 fsync 한 뒤 이름을 바꾼다. writeFileSync 는 여는 순간 비우므로
 * 쓰다 죽으면(강제 종료·업데이트 재시작) 빈 파일이 남는데, 이렇게 하면 옛 내용이나 새 내용 둘 중 하나만 남는다.
 * Windows 에서 다른 프로그램(백신·동기화)이 대상을 붙들고 있어 이름 바꾸기가 거부되면 제자리 쓰기로 물러난다.
 */
export function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      fs.writeFileSync(file, text);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 읽지 못한 설정 파일을 `<파일>.corrupt-<시각>` 으로 옮겨 둔다 — 기본값으로 덮어쓰기 전에 원본을 남긴다.
 * 파일이 아예 없으면(ENOENT) 처음 켠 것이므로 부르지 않는다. 옮긴 경로를 돌려주고, 옮기지 못하면 null.
 */
export function quarantine(file: string, reason: unknown): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  const why = reason instanceof Error ? reason.message : String(reason);
  try {
    fs.renameSync(file, target);
    console.warn(`${path.basename(file)} 을(를) 읽지 못해 ${target} 으로 옮겨 두었습니다: ${why}`);
    return target;
  } catch (err) {
    console.warn(`${path.basename(file)} 을(를) 읽지 못했고 옮기지도 못했습니다: ${why} / ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
