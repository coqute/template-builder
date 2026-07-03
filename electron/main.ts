import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGmailCreds, hasGmailDraftScope, CredError } from './gmail/credentials';
import { getAccessToken, OAuthError } from './gmail/oauth';
import { buildMimeMessage, toBase64Url } from './gmail/mime';
import type { DraftPayload, GmailDraftResult } from './gmail/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function resolveIconPath(): string {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (isDev) {
    return path.join(__dirname, '../assets', file);
  }
  return path.join(process.resourcesPath, 'assets', file);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'ExampleIT Template Builder',
    backgroundColor: '#FFFFFF',
    icon: resolveIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(VITE_DEV_URL);
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        {
          label: '새로 만들기',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new'),
        },
        {
          label: '샘플 불러오기',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('menu:load-sample'),
        },
        { type: 'separator' },
        {
          label: '열기...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open'),
        },
        {
          label: '저장',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '도구',
      submenu: [
        {
          label: 'Gmail 본문 가져오기',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow?.webContents.send('menu:import-gmail'),
        },
        {
          label: 'HTML 클립보드 복사',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => mainWindow?.webContents.send('menu:copy-html'),
        },
        { type: 'separator' },
        { role: 'reload', label: '새로고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: '키워드 가이드',
          accelerator: 'F1',
          click: () => mainWindow?.webContents.send('menu:help'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('dialog:open-md', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '.md 파일 열기',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  return { canceled: false, filePath, content };
});

ipcMain.handle(
  'dialog:save',
  async (
    _evt,
    payload: { defaultName: string; content: string; kind: 'md' | 'html' | 'json' },
  ) => {
    if (!mainWindow) return { canceled: true };
    const meta = {
      md: { ext: 'md', title: '.md 저장', name: 'Markdown' },
      html: { ext: 'html', title: 'HTML 저장', name: 'HTML' },
      json: { ext: 'json', title: '이메일 템플릿 저장', name: 'JSON' },
    }[payload.kind];
    const result = await dialog.showSaveDialog(mainWindow, {
      title: meta.title,
      defaultPath: `${payload.defaultName}.${meta.ext}`,
      filters: [{ name: meta.name, extensions: [meta.ext] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, payload.content, 'utf8');
    return { canceled: false, filePath: result.filePath };
  },
);

// 이미 경로가 확정된 파일에 다이얼로그 없이 덮어쓰기 (Ctrl+S 저장)
ipcMain.handle(
  'file:save-to-path',
  async (_evt, payload: { filePath: string; content: string }) => {
    try {
      if (!payload?.filePath) return { ok: false, error: '저장 경로가 없습니다.' };
      await fs.writeFile(payload.filePath, payload.content, 'utf8');
      return { ok: true, filePath: payload.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.handle('dialog:open-json', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '이메일 템플릿 열기',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  return { canceled: false, filePath, content };
});

ipcMain.handle('shell:open-external', async (_evt, url: string) => {
  // Gmail 작성창만 허용 (피싱/임의 URL 차단)
  if (typeof url === 'string' && url.startsWith('https://mail.google.com/')) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

// Gmail API 임시보관함(draft) 생성 — multipart/related + CID 인라인 이미지 (발송 안 함)
ipcMain.handle(
  'gmail:create-draft',
  async (_evt, payload: DraftPayload): Promise<GmailDraftResult> => {
    try {
      const creds = await loadGmailCreds();
      if (!hasGmailDraftScope(creds.scope)) {
        return { ok: false, code: 'scope-missing', message: 'Gmail 권한(스코프)이 부족합니다.' };
      }
      const raw = toBase64Url(buildMimeMessage(payload));
      const send = (token: string) =>
        fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { raw } }),
        });

      let token = await getAccessToken(creds);
      let res = await send(token);
      if (res.status === 401) {
        token = await getAccessToken(creds, true); // 강제 갱신 후 1회 재시도
        res = await send(token);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, code: 'gmail-error', message: `Gmail API ${res.status}: ${detail.slice(0, 200)}` };
      }
      const json = (await res.json()) as { id?: string; message?: { id?: string } };
      return { ok: true, draftId: json.id ?? '', messageId: json.message?.id };
    } catch (err) {
      if (err instanceof CredError) return { ok: false, code: 'credentials-missing', message: err.message };
      if (err instanceof OAuthError) return { ok: false, code: err.code, message: err.message };
      return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : '알 수 없는 오류' };
    }
  },
);

ipcMain.handle('asset:load-sample', async () => {
  const samplePath = isDev
    ? path.join(__dirname, '../assets/sample-week.md')
    : path.join(process.resourcesPath, 'assets/sample-week.md');
  try {
    return await fs.readFile(samplePath, 'utf8');
  } catch {
    return null;
  }
});

void app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
