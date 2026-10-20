/**
 * PC 앱 자동 업데이트 — GitHub 릴리즈의 latest.yml 을 보고 새 설치 파일을 받아 두었다가, 다시 시작하거나
 * 끝낼 때 설치한다(electron-updater, NSIS). 릴리즈 스크립트가 latest.yml·blockmap 을 설치 파일과 함께 올린다.
 *
 * - 설치본에서만 돈다. 개발 묶음은 disabled — 앱은 GitHub 릴리즈 페이지 안내로 돌아간다.
 * - LISTUP_DESKTOP_UPDATE_FEED 를 주면 GitHub 대신 그 주소(latest.yml 이 있는 폴더)를 본다 — 시험용. 개발 묶음도 그때는 돈다.
 * - LISTUP_DESKTOP_UPDATE_NO_INSTALL=1 이면 받기까지만 하고 설치(받은 파일 실행)는 하지 않는다 — 가짜 설치 파일로
 *   시험할 때(e2e/desktop.mjs). 끝낼 때 자동 설치도 끈다.
 * - 코드 서명을 하지 않아 받은 설치 파일의 서명은 보지 않는다. 대신 latest.yml 의 sha512 로 내용을 확인한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { DesktopUpdateState } from '@listup/shared';

/** 처음 확인은 앱이 뜨고 조금 뒤에 — 시작을 느리게 하지 않게. */
const FIRST_CHECK_MS = 15_000;
/** 그다음은 이 간격으로. 트레이에서 며칠씩 켜 두는 서버 PC 도 새 버전을 받게. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class Updater {
  private state: DesktopUpdateState;
  private listeners = new Set<(state: DesktopUpdateState) => void>();
  private readonly enabled: boolean;
  private readonly installAllowed = process.env.LISTUP_DESKTOP_UPDATE_NO_INSTALL !== '1';

  constructor() {
    const feed = process.env.LISTUP_DESKTOP_UPDATE_FEED;
    this.enabled = app.isPackaged || Boolean(feed);
    this.state = { status: this.enabled ? 'idle' : 'disabled', version: null, percent: null, error: null };
    if (!this.enabled) return;

    if (feed) {
      // 개발 묶음에는 설치본의 app-update.yml 이 없다 — 시험용 설정을 임시 폴더에 두고 가리킨다.
      if (!app.isPackaged) {
        const config = path.join(os.tmpdir(), `listup-dev-app-update-${process.pid}.yml`);
        fs.writeFileSync(config, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: listup-updater-test\n`);
        autoUpdater.updateConfigPath = config;
        autoUpdater.forceDevUpdateConfig = true;
      }
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    }
    autoUpdater.autoDownload = true;
    // 사용자가 그냥 끝내도 받아 둔 새 버전을 설치한다.
    autoUpdater.autoInstallOnAppQuit = this.installAllowed;
    autoUpdater.logger = {
      info: (m: unknown) => console.log(`[업데이트] ${String(m)}`),
      warn: (m: unknown) => console.warn(`[업데이트] ${String(m)}`),
      error: (m: unknown) => console.error(`[업데이트] ${String(m)}`),
      debug: () => {},
    };

    autoUpdater.on('checking-for-update', () => {
      // 이미 받아 두었으면 그 상태를 지킨다(다시 확인해도 같은 버전).
      if (this.state.status !== 'ready') this.set({ status: 'checking', error: null });
    });
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', version: null, percent: null }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, percent: 0, error: null }),
    );
    autoUpdater.on('download-progress', (progress) =>
      this.set({ status: 'downloading', percent: Math.floor(progress.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'ready', version: info.version, percent: 100, error: null }),
    );
    autoUpdater.on('error', (err) => {
      if (this.state.status === 'ready') return;
      this.set({ status: 'error', percent: null, error: describe(err) });
    });
  }

  /** 정해진 때마다 확인하기 시작한다. */
  start(): void {
    if (!this.enabled) return;
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref?.();
    setInterval(() => void this.check(), CHECK_INTERVAL_MS).unref?.();
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  onChange(listener: (state: DesktopUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<DesktopUpdateState> {
    if (!this.enabled) return this.state;
    // 받는 중이거나 받아 두었으면 다시 묻지 않는다.
    if (this.state.status === 'downloading' || this.state.status === 'ready' || this.state.status === 'checking') {
      return this.state;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', percent: null, error: describe(err) });
    }
    return this.state;
  }

  /** 받아 둔 새 버전을 조용히 설치하고 다시 켠다. 앱을 끄는 일(서버 정리)은 main 의 quit 흐름이 한다. */
  install(): boolean {
    if (this.state.status !== 'ready' || !this.installAllowed) return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  private set(patch: Partial<DesktopUpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/latest\.yml|404|Cannot find/i.test(message)) return '릴리즈에서 업데이트 정보를 찾지 못했습니다.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message)) return 'GitHub 에 닿지 못했습니다.';
  return message.split('\n')[0].slice(0, 200);
}
