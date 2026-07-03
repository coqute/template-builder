import { contextBridge, ipcRenderer } from 'electron';
import type { DraftPayload, GmailDraftResult } from './gmail/types';

type SaveKind = 'md' | 'html' | 'json';

const api = {
  openMd: () =>
    ipcRenderer.invoke('dialog:open-md') as Promise<
      | { canceled: true }
      | { canceled: false; filePath: string; content: string }
    >,
  openJson: () =>
    ipcRenderer.invoke('dialog:open-json') as Promise<
      | { canceled: true }
      | { canceled: false; filePath: string; content: string }
    >,
  save: (payload: { defaultName: string; content: string; kind: SaveKind }) =>
    ipcRenderer.invoke('dialog:save', payload) as Promise<
      { canceled: true } | { canceled: false; filePath: string }
    >,
  saveToPath: (filePath: string, content: string) =>
    ipcRenderer.invoke('file:save-to-path', { filePath, content }) as Promise<
      { ok: true; filePath: string } | { ok: false; error: string }
    >,
  readPath: (filePath: string) =>
    ipcRenderer.invoke('file:read-path', filePath) as Promise<
      { ok: true; content: string } | { ok: false; error: string }
    >,
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url) as Promise<{ ok: boolean }>,
  createGmailDraft: (payload: DraftPayload) =>
    ipcRenderer.invoke('gmail:create-draft', payload) as Promise<GmailDraftResult>,
  loadSample: () => ipcRenderer.invoke('asset:load-sample') as Promise<string | null>,
  onMenu: (handler: (channel: string) => void) => {
    const events = [
      'menu:new',
      'menu:load-sample',
      'menu:open',
      'menu:save',
      'menu:import-gmail',
      'menu:copy-html',
      'menu:help',
    ] as const;
    const listeners: Array<{ ch: string; fn: () => void }> = [];
    events.forEach((ch) => {
      const fn = () => handler(ch);
      ipcRenderer.on(ch, fn);
      listeners.push({ ch, fn });
    });
    return () => {
      listeners.forEach(({ ch, fn }) => ipcRenderer.removeListener(ch, fn));
    };
  },
};

contextBridge.exposeInMainWorld('reportApi', api);

export type ReportApi = typeof api;
