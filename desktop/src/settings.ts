import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { HostTunnelMode } from '@listup/shared';
import { atomicWrite, quarantine } from './atomic-write.ts';

/** PC 앱 설정. 앱 데이터 폴더의 settings.json 에 둔다. */
export interface Settings {
  port: number;
  tunnel: HostTunnelMode;
  autoStart: boolean;
  openAtLogin: boolean;
  /** null 이면 앱 데이터 폴더 안의 server-data. */
  dataDir: string | null;
  /** 창을 닫아도 서버가 돈다는 안내를 이미 보였는지. */
  trayNoticeShown: boolean;
  /** 서버 이름(LISTUP_SERVER_NAME 으로 넘긴다). null 이면 정하지 않음. */
  serverName: string | null;
  /** 업데이트를 설치하려고 끌 때 서버가 켜져 있었다 — 다시 켜지면 서버도 켠다. */
  resumeServerAfterUpdate: boolean;
}

const DEFAULTS: Settings = {
  port: 4000,
  tunnel: 'off',
  autoStart: false,
  openAtLogin: false,
  dataDir: null,
  trayNoticeShown: false,
  serverName: null,
  resumeServerAfterUpdate: false,
};

/** 서버 이름의 최대 길이 — 서버(config.ts)와 앱의 이름 칸과 같다. */
const MAX_SERVER_NAME_LENGTH = 60;

/** 앞뒤 공백·제어 문자를 떼고 길이를 자른다. 비면 null. */
export function cleanServerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? [...clean].slice(0, MAX_SERVER_NAME_LENGTH).join('') : null;
}

const file = () => path.join(app.getPath('userData'), 'settings.json');

let cached: Settings | null = null;
/** 이번 실행에서 settings.json 을 읽지 못해 기본값으로 시작했다면 그 안내. 이 PC 서버 화면에 보인다. */
let notice: string | null = null;

export function settingsNotice(): string | null {
  return notice;
}

export function readSettings(): Settings {
  if (cached) return cached;
  let raw: Partial<Settings> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('객체가 아닙니다');
    raw = parsed as Partial<Settings>;
  } catch (err) {
    // 없으면 처음 켠 것. 깨졌으면 원본을 옆에 남기고 기본값으로 — 데이터 폴더(dataDir)도 기본값이 되므로 알린다.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const moved = quarantine(file(), err);
      notice =
        '설정 파일(settings.json)이 손상돼 기본값으로 시작했습니다. 데이터 폴더가 맞는지 확인하세요' +
        (moved ? ` — 원래 파일은 ${moved} 에 있습니다.` : '.');
    }
  }
  const port = Number.isInteger(raw.port) && raw.port! >= 1 && raw.port! <= 65535 ? raw.port! : DEFAULTS.port;
  const tunnel: HostTunnelMode = raw.tunnel === 'tailscale' || raw.tunnel === 'quick' ? raw.tunnel : 'off';
  cached = {
    port,
    tunnel,
    autoStart: raw.autoStart === true,
    openAtLogin: raw.openAtLogin === true,
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir ? raw.dataDir : null,
    trayNoticeShown: raw.trayNoticeShown === true,
    serverName: cleanServerName(raw.serverName),
    resumeServerAfterUpdate: raw.resumeServerAfterUpdate === true,
  };
  return cached;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  atomicWrite(file(), `${JSON.stringify(next, null, 2)}\n`);
  cached = next;
  return next;
}

export function dataDirOf(settings: Settings): string {
  return settings.dataDir ?? path.join(app.getPath('userData'), 'server-data');
}
