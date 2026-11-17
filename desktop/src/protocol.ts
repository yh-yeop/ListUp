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
  hostOpenLogs: 'host:open-logs',
  foldersPick: 'folders:pick',
  foldersScan: 'folders:scan',
  foldersRead: 'folders:read',
  foldersSave: 'folders:save',
  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  telemetrySystem: 'telemetry:system',
  telemetryMemory: 'telemetry:memory',
  telemetryRead: 'telemetry:read',
  telemetryWrite: 'telemetry:write',
  telemetryAppend: 'telemetry:append',
  telemetryRemove: 'telemetry:remove',
  /** 동기(sendSync) — main 은 ipcMain.on 으로 받아 event.returnValue 를 늘 넣는다. */
  telemetryFinish: 'telemetry:finish',
  telemetryFolder: 'telemetry:folder',
  telemetryExport: 'telemetry:export',
  telemetryOpenFolder: 'telemetry:open-folder',
  /** 단방향(send) — 답을 기다리지 않는다. 받자마자 프로그램이 끝난다. */
  telemetryDebugCrash: 'telemetry:debug-crash',
  /** main → 창: 상태가 바뀌었다. */
  hostChanged: 'host:changed',
  /** main → 창: 업데이트 상태가 바뀌었다. */
  updatesChanged: 'updates:changed',
} as const;
