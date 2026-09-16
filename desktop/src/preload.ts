import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, HostStatus } from '@listup/shared';
import { IPC } from './protocol.ts';

/** 창(앱 웹 빌드)에 `window.listupDesktop` 을 넣는다. 계약은 shared 의 DesktopBridge. */
const bridge: DesktopBridge = {
  version: process.env.LISTUP_DESKTOP_VERSION ?? '0.0.0',
  credentials: {
    get: (key) => ipcRenderer.invoke(IPC.credentialsGet, key),
    set: (key, value) => ipcRenderer.invoke(IPC.credentialsSet, key, value),
    remove: (key) => ipcRenderer.invoke(IPC.credentialsRemove, key),
  },
  host: {
    getStatus: () => ipcRenderer.invoke(IPC.hostStatus),
    subscribe(listener) {
      const handler = (_event: unknown, status: HostStatus) => listener(status);
      ipcRenderer.on(IPC.hostChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC.hostChanged, handler);
      };
    },
    start: () => ipcRenderer.invoke(IPC.hostStart),
    stop: () => ipcRenderer.invoke(IPC.hostStop),
    update: (patch) => ipcRenderer.invoke(IPC.hostUpdate, patch),
    inspectTools: () => ipcRenderer.invoke(IPC.hostTools),
    issueResetCode: (email) => ipcRenderer.invoke(IPC.hostResetCode, email),
    backup: () => ipcRenderer.invoke(IPC.hostBackup),
    chooseDataFolder: () => ipcRenderer.invoke(IPC.hostChooseData),
    openDataFolder: () => ipcRenderer.invoke(IPC.hostOpenData),
    logs: () => ipcRenderer.invoke(IPC.hostLogs),
  },
  folders: {
    pick: () => ipcRenderer.invoke(IPC.foldersPick),
    scan: (root) => ipcRenderer.invoke(IPC.foldersScan, root),
    read: (root, relativePath, offset, length) => ipcRenderer.invoke(IPC.foldersRead, root, relativePath, offset, length),
    save: (root, relativePath, url) => ipcRenderer.invoke(IPC.foldersSave, root, relativePath, url),
  },
};

contextBridge.exposeInMainWorld('listupDesktop', bridge);
