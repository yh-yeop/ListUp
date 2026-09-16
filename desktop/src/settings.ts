import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { HostTunnelMode } from '@listup/shared';

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
}

const DEFAULTS: Settings = {
  port: 4000,
  tunnel: 'off',
  autoStart: false,
  openAtLogin: false,
  dataDir: null,
  trayNoticeShown: false,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

let cached: Settings | null = null;

export function readSettings(): Settings {
  if (cached) return cached;
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Settings>;
  } catch {
    // 처음 켰거나 깨졌다 — 기본값으로.
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
  };
  return cached;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  cached = next;
  return next;
}

export function dataDirOf(settings: Settings): string {
  return settings.dataDir ?? path.join(app.getPath('userData'), 'server-data');
}
