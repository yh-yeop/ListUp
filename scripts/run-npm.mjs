/**
 * npm 을 자식 프로세스로 실행한다.
 *
 * Windows 에서 npm 은 `npm.cmd` 인데, Node 20 부터는 `.cmd`·`.bat` 를 shell 없이 spawn 하면
 * EINVAL 로 막힌다(인자 주입 취약점 대응). 그렇다고 `shell: true` 로 넘기면 인자가
 * 이스케이프되지 않아 공백이나 따옴표가 든 값에서 깨진다(Node 가 DEP0190 으로 경고한다).
 *
 * 그래서 node 로 `npm-cli.js` 를 직접 돌린다 — shell 을 거치지 않으므로 인자가 그대로 간다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** node 와 함께 설치된 npm 의 진입점. 없으면 null. */
function npmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 리눅스·macOS 는 보통 bin 옆이 아니라 lib 아래에 둔다.
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function spawnNpm(args, options = {}) {
  const cli = npmCli();
  if (cli) return spawn(process.execPath, [cli, ...args], options);
  // npm 이 node 옆에 없는 환경(nvm, 별도 설치 등)은 shell 로 떨어진다.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, args, { ...options, shell: process.platform === 'win32' });
}
