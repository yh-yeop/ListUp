/**
 * 연결 문제 해결 — 서버에 닿지 않을 때 이유별로 무엇을 차례로 확인할지. 순수 함수(app/test 가 node 에서 검사한다).
 *
 * 예전에는 꺼짐·주소 틀림·ListUp 이 아닌 곳·시간 초과·터널 끝남이 모두 "닿지 않음" 한 가지였다. 이유를 나누고
 * (state/servers.ts `checkServer`), 주소 모양(공유기 안·빠른 터널·https 페이지의 http 주소)으로 흔한 원인을 짚는다.
 */

/** 닿지 않은 이유. */
export type UnreachableReason =
  /** 정해진 시간 안에 답이 없다 — 꺼졌거나, 방화벽이 막거나, 아주 느리다. */
  | 'timeout'
  /** 연결 자체가 안 됐다 — 주소가 없거나, 거부했거나, 인터넷이 끊겼거나, 브라우저가 막았다. */
  | 'network'
  /** 무언가 답했지만 오류 상태(404·502·530 …) — 터널·프록시가 서버를 못 찾을 때 흔하다. */
  | 'http'
  /** 답은 왔지만 ListUp 응답이 아니다 — 다른 웹사이트나 공유기 화면. */
  | 'not-listup';

export interface Diagnosis {
  status: 'ok' | 'unreachable' | 'server-older' | 'app-older';
  reason?: UnreachableReason;
  httpStatus?: number;
  version?: string | null;
}

export interface AddressFacts {
  /** 이 기기 주소(localhost·127.x) — 서버가 이 기기에서 돌 때만 닿는다. */
  thisDevice: boolean;
  /** 공유기 안 주소(192.168.x 등) — 같은 네트워크 밖에서는 닿지 않는다. */
  localNetwork: boolean;
  /** 켤 때마다 바뀌는 빠른 터널 주소(trycloudflare.com). */
  quickTunnel: boolean;
  /** https 페이지에서 http 서버를 부른다 — 브라우저가 막는다(혼합 콘텐츠). */
  mixedContent: boolean;
}

function hostOf(url: string): { host: string; protocol: string } | null {
  const match = /^(https?):\/\/([^/:?#\s]+)/i.exec(url.trim());
  return match ? { protocol: match[1].toLowerCase(), host: match[2].toLowerCase() } : null;
}

/** 같은 네트워크 안에서만 닿는 주소 — 공유기 안(192.168·10·172.16–31)·이 기기(localhost·127)·`.local`. */
export function isLocalAddress(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** `pageProtocol` 은 웹에서 지금 페이지의 `location.protocol`('https:'), 앱이면 null. */
export function addressFacts(url: string, pageProtocol: string | null = null): AddressFacts {
  const parsed = hostOf(url);
  if (!parsed) return { thisDevice: false, localNetwork: false, quickTunnel: false, mixedContent: false };
  const thisDevice = parsed.host === 'localhost' || /^127\./.test(parsed.host);
  return {
    thisDevice,
    localNetwork: !thisDevice && isLocalAddress(parsed.host),
    quickTunnel: parsed.host.endsWith('.trycloudflare.com'),
    mixedContent: pageProtocol === 'https:' && parsed.protocol === 'http' && parsed.host !== 'localhost',
  };
}

export interface Step {
  title: string;
  detail: string;
}

export interface Advice {
  /** 한 줄 요약 — 무엇이 일어났나. */
  summary: string;
  /** 확인할 것, 가능성 높은 것부터. */
  steps: Step[];
}

const SERVER_ON: Step = {
  title: '서버가 켜져 있는지',
  detail: '서버를 돌리는 PC 가 켜져 있고 ListUp 서버가 실행 중인지 운영자에게 물어보세요. PC 가 잠자기에 들어가도 끊깁니다.',
};
const INTERNET: Step = {
  title: '이 기기의 인터넷',
  detail: '다른 웹사이트가 열리는지 보세요. 회사·학교 와이파이는 낯선 주소를 막기도 합니다 — 휴대폰 데이터로 바꿔 보세요.',
};
const ADDRESS: Step = {
  title: '주소가 맞는지',
  detail: '받은 주소와 한 글자씩 견줘 보세요. 서버 목록에서 이 서버의 설정(톱니바퀴)을 눌러 주소를 고칠 수 있습니다.',
};

/** 진단 결과와 주소 모양으로 안내를 만든다. 들어갈 수 있으면(ok) 확인할 것이 없다. */
export function troubleshootAdvice(diagnosis: Diagnosis, facts: AddressFacts): Advice {
  const version = diagnosis.version ? ` (v${diagnosis.version})` : '';
  if (diagnosis.status === 'ok') {
    return { summary: `서버${version}에 잘 닿습니다. 지금은 들어갈 수 있습니다.`, steps: [] };
  }
  if (diagnosis.status === 'server-older') {
    return {
      summary: `서버${version}가 이 앱보다 오래된 버전입니다.`,
      steps: [{ title: '서버 업데이트', detail: '운영자에게 ListUp 서버를 최신으로 올려 달라고 부탁하세요. 앱은 그대로 두면 됩니다.' }],
    };
  }
  if (diagnosis.status === 'app-older') {
    return {
      summary: `이 앱이 서버${version}보다 오래된 버전입니다.`,
      steps: [{ title: '앱 업데이트', detail: '내 정보·서버 목록 아래의 「업데이트 확인」으로 새 버전을 받으세요.' }],
    };
  }

  const steps: Step[] = [];
  // 주소 모양으로 거의 확실한 원인부터.
  if (facts.mixedContent) {
    steps.push({
      title: '보안 연결(https) 페이지에서는 http 서버에 못 들어갑니다',
      detail: '브라우저가 막습니다. PC 앱이나 안드로이드 앱으로 들어가거나, 운영자에게 https 주소(터널·Tailscale)를 받으세요.',
    });
  }
  if (facts.quickTunnel) {
    steps.push({
      title: '빠른 터널 주소는 서버를 켤 때마다 바뀝니다',
      detail: 'trycloudflare.com 주소는 서버를 다시 켜면 새 주소가 됩니다. 운영자에게 지금 주소를 다시 받아 서버 목록에서 고치세요.',
    });
  }
  if (facts.thisDevice) {
    steps.push({
      title: '이 기기 주소(localhost)입니다',
      detail: '서버가 지금 이 기기에서 돌 때만 닿습니다. 다른 PC 의 서버라면 그 PC 의 주소를 받아 고치세요.',
    });
  }
  if (facts.localNetwork) {
    steps.push({
      title: '같은 와이파이(공유기) 안에서만 되는 주소입니다',
      detail: '192.168… 같은 주소는 서버와 같은 공유기에 있어야 닿습니다. 밖이라면 운영자에게 바깥에서 들어오는 주소를 받으세요.',
    });
  }

  let summary: string;
  switch (diagnosis.reason) {
    case 'timeout':
      summary = '서버가 정해진 시간 안에 답하지 않았습니다.';
      steps.push(SERVER_ON, INTERNET);
      break;
    case 'http':
      summary = `주소에서 오류(HTTP ${diagnosis.httpStatus ?? '?'})가 돌아왔습니다. 터널이나 프록시는 살아 있지만 그 뒤의 서버를 못 찾는 경우가 많습니다.`;
      steps.push(SERVER_ON, ADDRESS);
      break;
    case 'not-listup':
      summary = '답은 왔지만 ListUp 서버가 아닙니다. 다른 웹사이트나 공유기 화면일 수 있습니다.';
      steps.push(ADDRESS, {
        title: '포트',
        detail: 'ListUp 서버의 기본 포트는 4000 입니다. 주소 끝에 :4000 을 붙여 보거나 운영자에게 포트를 물어보세요.',
      });
      break;
    default:
      summary = '서버에 연결하지 못했습니다.';
      steps.push(INTERNET, SERVER_ON, ADDRESS);
  }
  return { summary, steps };
}
