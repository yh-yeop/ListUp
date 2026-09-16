import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { createSocket } from 'node:dgram';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { HostSettingsPatch, HostState, HostStatus } from '@listup/shared';
import type { ServerReply, ServerRequest } from './protocol.ts';
import { dataDirOf, readSettings, writeSettings } from './settings.ts';
import { Tunnel } from './tunnel.ts';

/** 서버 프로세스를 띄우는 데 필요한 파일 위치. main 이 개발/설치에 맞춰 정한다. */
export interface HostPaths {
  /** 묶은 서버(server-entry) 파일. */
  serverEntry: string;
  /** 서버가 함께 서빙할 웹 빌드(서버 모드). 없으면 API 만. */
  serverWeb: string;
}

const LOG_LINES = 300;
const START_TIMEOUT_MS = 60_000;

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

/**
 * 바깥으로 나갈 때 쓰는 인터페이스의 IPv4 주소 (scripts/start-app.mjs 와 같은 방법). 패킷은 보내지 않는다.
 * VirtualBox·Hyper-V 같은 가상 어댑터 주소는 폰에서 닿지 않으므로 이 주소를 맨 앞에 둔다.
 */
function outboundAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (value: string | null) => {
      try {
        socket.close();
      } catch {
        // 이미 닫혔다.
      }
      resolve(value);
    };
    socket.on('error', () => done(null));
    try {
      socket.connect(53, '8.8.8.8', () => {
        const { address } = socket.address();
        done(address && address !== '0.0.0.0' ? address : null);
      });
    } catch {
      done(null);
    }
  });
}

/** 같은 공유기에서 들어오는 주소. 바깥으로 나가는 인터페이스가 맨 앞. */
function lanUrls(port: number, primary: string | null): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const [a, b] = net.address.split('.').map(Number);
      const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
      if (isPrivate) addresses.push(net.address);
    }
  }
  addresses.sort((x, y) => Number(y === primary) - Number(x === primary));
  return addresses.map((address) => `http://${address}:${port}`);
}

/** pino JSON 한 줄을 사람이 읽을 한 줄로. JSON 이 아니면 그대로. */
function formatLogLine(line: string): string {
  try {
    const entry = JSON.parse(line) as {
      time?: number;
      level?: number;
      msg?: string;
      req?: { method?: string; url?: string; remoteAddress?: string };
      res?: { statusCode?: number };
      err?: { message?: string };
    };
    const at = new Date(entry.time ?? Date.now());
    const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    const level = (entry.level ?? 30) >= 50 ? '오류 ' : (entry.level ?? 30) >= 40 ? '경고 ' : '';
    let text = entry.msg ?? '';
    if (entry.req) text = `${entry.req.remoteAddress ?? ''} ${entry.req.method ?? ''} ${entry.req.url ?? ''}`;
    if (entry.res && text === 'request completed') text = `→ ${entry.res.statusCode}`;
    if (entry.err?.message) text += ` — ${entry.err.message}`;
    return `${time} ${level}${text}`.trim();
  } catch {
    return line;
  }
}

/** 이 PC 에서 여는 서버 — 서버 프로세스, 공개 주소, 설정을 묶는다. `change` 이벤트로 상태를 알린다. */
export class Host extends EventEmitter {
  private child: UtilityProcess | null = null;
  private state: HostState = 'stopped';
  private error: string | null = null;
  private readonly tunnel = new Tunnel(() => this.emitChange());
  private readonly logLines: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private primaryAddress: string | null = null;

  constructor(private readonly paths: HostPaths) {
    super();
    void this.refreshAddress();
  }

  private async refreshAddress(): Promise<void> {
    const address = await outboundAddress();
    if (address === this.primaryAddress) return;
    this.primaryAddress = address;
    this.emitChange();
  }

  status(): HostStatus {
    const settings = readSettings();
    return {
      state: this.state,
      error: this.error,
      port: settings.port,
      localUrl: `http://localhost:${settings.port}`,
      lanUrls: lanUrls(settings.port, this.primaryAddress),
      // 꺼져 있을 때도 고른 방식은 보여 준다 — 서버를 켜면 그 방식으로 연다.
      tunnel: this.tunnel.current.state === 'off' ? { ...this.tunnel.current, mode: settings.tunnel } : this.tunnel.current,
      dataDir: dataDirOf(settings),
      autoStart: settings.autoStart,
      openAtLogin: settings.openAtLogin,
    };
  }

  get running(): boolean {
    return this.state === 'running' || this.state === 'starting';
  }

  logs(): string[] {
    return [...this.logLines];
  }

  private emitChange(): void {
    this.emit('change', this.status());
  }

  private setState(state: HostState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.emitChange();
  }

  private log(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logLines.push(formatLogLine(line));
    }
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  /** 서명 키 — 없으면 만든다. 없이 켜면 켤 때마다 새 키라 모두 로그아웃된다. */
  private authSecret(dataDir: string): string {
    const file = `${dataDir}/auth-secret.txt`;
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`);
    return fs.readFileSync(file, 'utf8').trim();
  }

  private fork(mode: 'serve' | 'task'): UtilityProcess {
    const settings = readSettings();
    const dataDir = dataDirOf(settings);
    // PC 앱 전용 변수(LISTUP_DESKTOP_*)는 서버가 모르는 이름이라 경고하므로 넘기지 않는다.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('LISTUP_DESKTOP_')),
    );
    return utilityProcess.fork(this.paths.serverEntry, [mode], {
      serviceName: 'ListUp 서버',
      stdio: 'pipe',
      env: {
        ...inherited,
        NODE_ENV: 'production',
        LISTUP_DATA_DIR: dataDir,
        LISTUP_AUTH_SECRET: this.authSecret(dataDir),
        LISTUP_PORT: String(settings.port),
        LISTUP_WEB_DIR: this.paths.serverWeb,
        LISTUP_LOG_LEVEL: process.env.LISTUP_LOG_LEVEL ?? 'info',
      },
    });
  }

  async start(): Promise<HostStatus> {
    if (this.running) return this.status();
    this.setState('starting');
    void this.refreshAddress();
    const settings = readSettings();

    let child: UtilityProcess;
    try {
      child = this.fork('serve');
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err));
      return this.status();
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString()));

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('서버가 60초 안에 뜨지 않았습니다.')), START_TIMEOUT_MS);
      child.on('message', (message: ServerReply) => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (message.type === 'failed') {
          clearTimeout(timer);
          reject(
            new Error(
              message.code === 'EADDRINUSE'
                ? `포트 ${settings.port} 을(를) 이미 다른 프로그램이 쓰고 있습니다. 포트를 바꾸거나 그 프로그램을 끄세요.`
                : message.message,
            ),
          );
        } else if (message.type === 'result') {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          if (message.ok) waiting.resolve(message.value);
          else waiting.reject(new Error(message.error));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const last = this.logLines.at(-1);
        reject(new Error(`서버가 뜨지 못하고 멈췄습니다 (${code})${last ? `: ${last}` : '. 로그를 확인하세요.'}`));
      });
    });

    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.tunnel.close();
      for (const waiting of this.pending.values()) waiting.reject(new Error('서버가 꺼졌습니다.'));
      this.pending.clear();
      if (this.state === 'stopping') this.setState('stopped');
      else if (this.state === 'running') this.setState('error', `서버가 예기치 않게 멈췄습니다 (${code}). 로그를 확인하세요.`);
    });

    try {
      await ready;
    } catch (err) {
      if (this.child === child) this.child = null;
      child.kill();
      this.setState('error', err instanceof Error ? err.message : String(err));
      return this.status();
    }
    this.setState('running');
    void this.tunnel.open(settings.tunnel, settings.port);
    return this.status();
  }

  async stop(): Promise<HostStatus> {
    const child = this.child;
    if (!child) {
      if (this.state === 'error') this.setState('stopped');
      return this.status();
    }
    this.setState('stopping');
    this.tunnel.close();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.postMessage({ id: this.nextId++, type: 'stop' } satisfies ServerRequest);
    const timer = setTimeout(() => child.kill(), 12_000);
    await exited;
    clearTimeout(timer);
    return this.status();
  }

  /** 켜져 있는 서버에 일을 시킨다. 꺼져 있으면 DB 만 여는 프로세스를 잠깐 띄운다. */
  private async request<T>(body: { type: 'reset-code'; email: string } | { type: 'backup'; dir: string }): Promise<T> {
    const id = this.nextId++;
    if (this.child && this.state === 'running') {
      const child = this.child;
      const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      child.postMessage({ id, ...body } satisfies ServerRequest);
      return (await result) as T;
    }
    const task = this.fork('task');
    task.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString()));
    try {
      return await new Promise<T>((resolve, reject) => {
        task.on('message', (message: ServerReply) => {
          if (message.type === 'ready') task.postMessage({ id, ...body } satisfies ServerRequest);
          else if (message.type === 'result' && message.id === id) {
            if (message.ok) resolve(message.value as T);
            else reject(new Error(message.error));
          }
        });
        task.on('exit', (code) => reject(new Error(`작업이 끝나지 못했습니다 (${code}).`)));
      });
    } finally {
      task.kill();
    }
  }

  issueResetCode(email: string): Promise<{ code: string; expiresAt: number } | null> {
    if (this.state !== 'running') return Promise.reject(new Error('서버가 켜져 있을 때만 발급할 수 있습니다.'));
    return this.request({ type: 'reset-code', email });
  }

  backup(dir: string): Promise<string> {
    return this.request({ type: 'backup', dir });
  }

  async update(patch: HostSettingsPatch): Promise<HostStatus> {
    const before = readSettings();
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new Error('포트는 1~65535 사이의 정수여야 합니다.');
      }
      if (this.running && patch.port !== before.port) throw new Error('포트는 서버를 끈 뒤에 바꿀 수 있습니다.');
    }
    const after = writeSettings(patch);
    if (patch.tunnel !== undefined && patch.tunnel !== before.tunnel) {
      // Funnel 설정은 tailscaled 가 기억하므로, 공개를 그만두면 그것까지 꺼야 밖에서 안 들어온다.
      if (before.tunnel === 'tailscale') await Tunnel.disableTailscale();
      if (this.state === 'running') void this.tunnel.open(after.tunnel, after.port);
    }
    this.emitChange();
    return this.status();
  }

  setDataDir(dir: string): HostStatus {
    if (this.running) throw new Error('데이터 폴더는 서버를 끈 뒤에 바꿀 수 있습니다.');
    writeSettings({ dataDir: dir });
    this.emitChange();
    return this.status();
  }
}
