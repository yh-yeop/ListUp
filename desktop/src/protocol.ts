/** 앱 본체(main) ↔ 서버 프로세스(server-entry) 메시지. */

export type ServerRequest =
  | { id: number; type: 'reset-code'; email: string }
  | { id: number; type: 'backup'; dir: string }
  | { id: number; type: 'stop' };

export type ServerReply =
  | { type: 'ready' }
  | { type: 'failed'; code: string | null; message: string }
  | { type: 'stopped' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** main ↔ 창(preload) IPC 채널 이름. */
export const IPC = {
  credentialsGet: 'credentials:get',
  credentialsSet: 'credentials:set',
  credentialsRemove: 'credentials:remove',
  hostStatus: 'host:status',
  hostStart: 'host:start',
  hostStop: 'host:stop',
  hostUpdate: 'host:update',
  hostTools: 'host:tools',
  hostResetCode: 'host:reset-code',
  hostBackup: 'host:backup',
  hostChooseData: 'host:choose-data',
  hostOpenData: 'host:open-data',
  hostLogs: 'host:logs',
  /** main → 창: 상태가 바뀌었다. */
  hostChanged: 'host:changed',
} as const;
