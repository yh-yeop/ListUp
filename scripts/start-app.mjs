/**
 * Expo 개발 서버를 띄우되, 실기기가 접속할 IP 를 먼저 확정한다.
 *
 * Expo 는 실기기에 줄 주소(hostUri)를 스스로 고르는데, VirtualBox·Docker 같은 가상 어댑터가
 * 있으면 폰에서 닿지 않는 IP(예: 192.168.56.1)를 고르는 일이 있다. 그러면 QR 을 찍어도
 * 연결되지 않고, 앱이 hostUri 로 유추하는 API 주소(`http://<host>:4000`)까지 함께 어긋난다.
 *
 * 기본 경로(default route)로 나가는 인터페이스의 IP 를 골라 REACT_NATIVE_PACKAGER_HOSTNAME
 * 으로 넘긴다. 네트워크가 없으면 아무것도 정하지 않고 Expo 판단에 맡긴다.
 */
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';

/** 바깥으로 나갈 때 쓰는 인터페이스의 IPv4 주소. 패킷은 보내지 않는다. */
function outboundAddress() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (value) => {
      try {
        socket.close();
      } catch {
        // 이미 닫혔으면 그만이다.
      }
      resolve(value);
    };
    socket.on('error', () => done(null));
    try {
      // 8.8.8.8 은 목적지일 뿐 실제로 통신하지 않는다 — 커널이 경로만 고르게 한다.
      socket.connect(53, '8.8.8.8', () => {
        const address = socket.address().address;
        done(typeof address === 'string' && address !== '0.0.0.0' ? address : null);
      });
    } catch {
      done(null);
    }
  });
}

const host = process.env.REACT_NATIVE_PACKAGER_HOSTNAME ?? (await outboundAddress());
// `npm run app -- --tunnel` 처럼 뒤에 붙인 인자는 expo 에 그대로 넘긴다.
const extra = process.argv.slice(2);
// --tunnel 은 폰이 다른 네트워크(LTE 등)에 있을 때 Metro 를 인터넷에 공개한다(@expo/ngrok 필요).
// 이때는 LAN IP 가 쓰이지 않고, 앱이 접속 주소에서 유추하는 API 주소도 맞지 않으므로
// 앱의 "서버 주소" 화면에서 공개된 서버 주소를 직접 지정해야 한다.
const tunneled = extra.includes('--tunnel');

const env = { ...process.env };
if (tunneled) {
  console.log('Expo 터널 모드 — Metro 를 인터넷에 공개합니다. 폰이 다른 네트워크여도 됩니다.');
  console.log('앱의 "서버 주소" 화면에서 공개된 서버 주소를 지정해 주세요.\n');
} else if (host) {
  env.REACT_NATIVE_PACKAGER_HOSTNAME = host;
  console.log(`실기기가 접속할 주소: exp://${host}:8081 (API 는 http://${host}:4000)`);
  console.log('폰과 이 PC 가 같은 공유기에 있어야 합니다.\n');
} else {
  console.log('LAN 주소를 찾지 못했습니다 — Expo 가 고르는 주소를 씁니다.\n');
}

// Windows 에서 npm 은 npm.cmd 다. shell:true 로 넘기면 인자가 이스케이프되지 않아 경고가 난다.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'start', '--workspace', '@listup/app', '--', ...extra], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 0));
