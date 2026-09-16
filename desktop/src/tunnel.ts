import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { HostTools, HostTunnelMode, HostTunnelStatus } from '@listup/shared';

/**
 * 공개 주소 — `scripts/tunnel.mjs`·`serve.mjs` 와 같은 방식을 앱 안에서.
 *
 *   tailscale  Tailscale Funnel. `*.ts.net` 고정 주소. `--bg` 라 앱을 꺼도 Funnel 설정은 남는다
 *              (서버가 꺼져 있으면 그 주소는 502).
 *   quick      Cloudflare 빠른 터널. 계정 없이 되지만 켤 때마다 주소가 바뀌고, 앱이 cloudflared 를 붙들고 있다.
 *
 * 이름 있는 Cloudflare 터널은 도메인이 있어야 해 앱에서는 다루지 않는다 (명령줄 `npm run serve`).
 */

function findBinary(name: string, guesses: string[]): string | null {
  const onPath = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
  }
  return guesses.find((p) => fs.existsSync(p)) ?? null;
}

const findTailscale = () => findBinary('tailscale', ['C:\\Program Files\\Tailscale\\tailscale.exe']);
const findCloudflared = () =>
  findBinary('cloudflared', [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ]);

/** Tailscale 에 로그인돼 있으면 이 PC 의 고정 주소(호스트 이름). */
function tailscaleHostname(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const status = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
        const dns = status.Self?.DNSName;
        resolve(status.BackendState === 'Running' && dns ? dns.replace(/\.$/, '') : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function inspectTools(): Promise<HostTools> {
  const tailscale = findTailscale();
  return {
    tailscale: { installed: tailscale !== null, hostname: tailscale ? await tailscaleHostname(tailscale) : null },
    cloudflared: { installed: findCloudflared() !== null },
  };
}

const OFF: HostTunnelStatus = { mode: 'off', state: 'off', url: null, message: null, actionUrl: null };

export class Tunnel {
  private status: HostTunnelStatus = OFF;
  private child: ChildProcess | null = null;
  /** 켜기를 여러 번 누르거나 방식을 바꿨을 때 늦게 끝난 이전 시도가 상태를 덮지 않게. */
  private generation = 0;

  constructor(private readonly onChange: () => void) {}

  get current(): HostTunnelStatus {
    return this.status;
  }

  private set(next: HostTunnelStatus, generation: number): void {
    if (generation !== this.generation) return;
    this.status = next;
    this.onChange();
  }

  /** 서버가 뜬 뒤에 부른다. */
  async open(mode: HostTunnelMode, port: number): Promise<void> {
    this.close();
    const generation = ++this.generation;
    if (mode === 'off') return this.set(OFF, generation);
    const base = { mode, url: null, message: null, actionUrl: null };
    this.set({ ...base, state: 'starting' }, generation);
    if (mode === 'tailscale') await this.openTailscale(port, generation);
    else this.openQuick(port, generation);
  }

  private async openTailscale(port: number, generation: number): Promise<void> {
    const fail = (message: string) =>
      this.set({ mode: 'tailscale', state: 'error', url: null, message, actionUrl: null }, generation);
    const binary = findTailscale();
    if (!binary) return fail('Tailscale 이 설치돼 있지 않습니다.');
    const hostname = await tailscaleHostname(binary);
    if (!hostname) return fail('Tailscale 에 로그인돼 있지 않습니다. Tailscale 앱에서 로그인해 주세요.');

    // 처음 한 번은 관리 화면에서 Funnel(과 HTTPS 인증서)을 허용하라는 링크를 내고, 허용할 때까지 기다린다.
    const child = spawn(binary, ['funnel', '--bg', String(port)], { windowsHide: true });
    this.child = child;
    let output = '';
    const watch = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      const link = output.match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (link) {
        this.set(
          {
            mode: 'tailscale',
            state: 'starting',
            url: null,
            message: 'Tailscale 관리 화면에서 Funnel 을 허용해 주세요. 허용하면 저절로 이어집니다.',
            actionUrl: link[0],
          },
          generation,
        );
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.on('error', (err) => fail(`Tailscale 을 실행하지 못했습니다: ${err.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (code === 0) {
        this.set(
          { mode: 'tailscale', state: 'on', url: `https://${hostname}`, message: null, actionUrl: null },
          generation,
        );
      } else if (code !== null) {
        const last = output.trim().split(/\r?\n/).filter(Boolean).pop();
        fail(`Funnel 을 켜지 못했습니다${last ? `: ${last}` : '.'}`);
      }
    });
  }

  private openQuick(port: number, generation: number): void {
    const fail = (message: string) =>
      this.set({ mode: 'quick', state: 'error', url: null, message, actionUrl: null }, generation);
    const binary = findCloudflared();
    if (!binary) return fail('cloudflared 가 설치돼 있지 않습니다 (winget install Cloudflare.cloudflared).');

    const child = spawn(binary, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      windowsHide: true,
    });
    this.child = child;
    let url: string | null = null;
    const watch = (chunk: Buffer) => {
      const found = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found && !url) {
        url = found[0];
        this.set(
          { mode: 'quick', state: 'on', url, message: '임시 주소입니다. 서버를 다시 켜면 바뀝니다.', actionUrl: null },
          generation,
        );
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.on('error', (err) => fail(`cloudflared 를 실행하지 못했습니다: ${err.message}`));
    child.on('exit', () => {
      if (this.child !== child) return; // 우리가 닫았다
      this.child = null;
      fail('빠른 터널이 끊겼습니다. 서버를 다시 켜 주세요.');
    });
  }

  /** 앱이 붙들고 있는 것(빠른 터널, 기다리는 Funnel 명령)을 닫는다. Tailscale Funnel 설정은 남는다. */
  close(): void {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.status = OFF;
  }

  /** 공개하지 않기로 했을 때 — 남아 있는 Funnel 설정까지 끈다. */
  static disableTailscale(): Promise<void> {
    const binary = findTailscale();
    if (!binary) return Promise.resolve();
    return new Promise((resolve) => {
      execFile(binary, ['funnel', '--https=443', 'off'], { timeout: 10_000, windowsHide: true }, () => resolve());
    });
  }
}
