import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGmailCreds, hasGmailDraftScope, CredError } from './gmail/credentials';
import { getAccessToken, OAuthError } from './gmail/oauth';
import { buildMimeMessage, toBase64Url } from './gmail/mime';
import { upsertDraft } from './gmail/upsert';
import type { DraftPayload, GmailDraftResult } from './gmail/types';
import { registerAiIpc } from './ai';
import { registerWorklogIpc } from './worklog';
import { registerPlannerIpc } from './planner';
import { registerCalendarIpc } from './calendar';
import { registerNotionIpc } from './notion';
import { writeFileAtomic } from './atomic';
import { kindOf, rememberDir, startDir } from './dialog-dir';
import { isAllowedExternalUrl } from './external-url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// renderer가 통지하는 "파일 미저장 변경" 상태 — 창 닫기 전 확인용
let rendererDirty = false;
ipcMain.on('app:set-dirty', (_evt, v: unknown) => {
  rendererDirty = Boolean(v);
});

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
    title: 'Template Builder',
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

  // 열려 있는 .md에 저장되지 않은 변경이 있으면 닫기 전 확인 (초안 자체는 localStorage에 보관됨)
  mainWindow.on('close', (e) => {
    if (!rendererDirty || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['닫기', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: '저장되지 않은 변경',
      message: '열려 있는 파일에 저장되지 않은 변경이 있습니다. 그래도 닫을까요?',
      // 주간보고(.md)·작업일지(.txt) 공용 문구 — 둘 다 저장 전 내용을 앱에 보관한다
      detail: '저장 전 내용은 앱에 자동 보관되지만, 파일에는 아직 저장되지 않았습니다. (Ctrl+S로 저장)',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
    rendererDirty = false; // 확인됨 — 기본 close 진행 (재확인 루프 방지)
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const send = (channel: string) => () => mainWindow?.webContents.send(channel);
  // 새로고침·개발자 도구는 개발 중에만 — 배포본 사용자에게는 혼란·오조작 요인
  const devItems: Electron.MenuItemConstructorOptions[] = isDev
    ? [{ type: 'separator' }, { role: 'reload', label: '새로고침' }, { role: 'toggleDevTools', label: '개발자 도구' }]
    : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        { label: '새로 만들기', accelerator: 'CmdOrCtrl+N', click: send('menu:new') },
        { label: '열기...', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { type: 'separator' },
        { label: '샘플 보기', accelerator: 'CmdOrCtrl+L', click: send('menu:load-sample') },
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
      label: '보내기',
      submenu: [
        { label: 'HTML 복사', accelerator: 'CmdOrCtrl+Shift+C', click: send('menu:copy-html') },
        // Ctrl+Enter는 렌더러가 처리 — 메뉴에는 표시만 (중복 실행 방지)
        { label: '임시보관함 (Gmail 초안)', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: send('menu:draft') },
        { type: 'separator' },
        { label: 'Gmail 본문 가져오기', accelerator: 'CmdOrCtrl+Shift+I', click: send('menu:import-gmail') },
      ],
    },
    {
      label: '도움말',
      submenu: [{ label: '도움말 · 설정', accelerator: 'F1', click: send('menu:help') }, ...devItems],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('dialog:open-md', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '.md 파일 열기',
    // Electron 43부터 defaultPath가 없으면 다운로드 폴더에서 열린다 — 마지막에 쓴 폴더를 넘긴다(dialog-dir.ts)
    defaultPath: await startDir('md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  void rememberDir('md', filePath);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { canceled: false, filePath, content };
  } catch (err) {
    // 선택 직후 삭제·권한 거부 등 — rejection 대신 판별 가능한 실패로 반환 (renderer가 toast)
    return { canceled: true, error: `파일을 읽을 수 없습니다: ${errMsg(err)}` };
  }
});

const SAVE_META = {
  md: { ext: 'md', title: '.md 저장', name: 'Markdown' },
  html: { ext: 'html', title: 'HTML 저장', name: 'HTML' },
  json: { ext: 'json', title: '이메일 템플릿 저장', name: 'JSON' },
} as const;

ipcMain.handle(
  'dialog:save',
  async (
    _evt,
    payload: { defaultName: string; content: string; kind: 'md' | 'html' | 'json' },
  ) => {
    if (!mainWindow) return { canceled: true };
    // preload 밖에서 들어올 수 있는 payload — kind/content 검증 (잘못된 kind면 meta undefined로 크래시하던 경로)
    const meta = SAVE_META[payload?.kind as keyof typeof SAVE_META];
    if (!meta || typeof payload.content !== 'string') {
      return { canceled: true, error: '허용되지 않는 저장 요청입니다 (md/html/json).' };
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: meta.title,
      // 파일 이름만 주면 다운로드 폴더에서 열린다(Electron 43+) — 이 종류를 마지막에 저장·연 폴더를 붙인다
      defaultPath: path.join(await startDir(meta.ext), `${String(payload.defaultName ?? '')}.${meta.ext}`),
      filters: [{ name: meta.name, extensions: [meta.ext] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    void rememberDir(meta.ext, result.filePath);
    try {
      // 임시 파일에 쓴 뒤 바꿔치기 — 쓰다 끊겨도(디스크 부족·연결 끊김) 기존 파일이 빈 파일·반쪽 파일로 남지 않는다
      await writeFileAtomic(result.filePath, payload.content, { fallbackDirect: true });
      return { canceled: false, filePath: result.filePath };
    } catch (err) {
      // 읽기 전용 경로·잠긴 파일 등 — 무통지 실패 대신 renderer가 실패 toast를 띄우도록
      return { canceled: true, error: `저장하지 못했습니다: ${errMsg(err)}` };
    }
  },
);

// 템플릿 오버레이 로드 — 개인(userData/templates) + 팀(설정된 폴더의 templates/) *.json.
// JSON 파싱까지만 main에서, 스키마 검증은 renderer(validateTemplateData)가 수행.
const MAX_TEMPLATE_BYTES = 200 * 1024;

interface RawTemplateFile {
  name: string;
  raw: unknown;
}

async function readTemplateDir(dir: string): Promise<{ items: RawTemplateFile[]; errors: string[] }> {
  const items: RawTemplateFile[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { items, errors }; // 폴더 없음 — 무해
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_TEMPLATE_BYTES) {
        errors.push(`${name}: 200KB 크기 상한 초과`);
        continue;
      }
      items.push({ name, raw: JSON.parse(await fs.readFile(p, 'utf8')) });
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { items, errors };
}

ipcMain.handle('templates:load', async (_evt, teamDir?: string) => {
  const personal = await readTemplateDir(path.join(app.getPath('userData'), 'templates'));
  const team =
    typeof teamDir === 'string' && teamDir.trim() && path.isAbsolute(teamDir)
      ? await readTemplateDir(path.join(teamDir, 'templates'))
      : { items: [], errors: [] };
  return { team: team.items, personal: personal.items, errors: [...team.errors, ...personal.errors] };
});

// 개인 템플릿 폴더 열기 (없으면 생성) — 사용자가 JSON을 직접 넣는 진입점
ipcMain.handle('templates:open-dir', async () => {
  const dir = path.join(app.getPath('userData'), 'templates');
  try {
    await fs.mkdir(dir, { recursive: true });
    const openErr = await shell.openPath(dir); // 실패 시 빈 문자열이 아닌 오류 메시지 반환
    if (openErr) return { ok: false, dir, error: openErr };
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: errMsg(err) };
  }
});

// HTML+plain 클립보드 쓰기 — 네이티브 경로 (renderer navigator.clipboard의 포커스/권한 제약 회피)
// Electron 44부터 clipboard는 W3C Clipboard API 모양이다 — ClipboardItem(MIME → 값) 배열을 받고 Promise를 돌려준다.
// 한 번의 write에 넣은 형식들은 한꺼번에 클립보드에 올라간다(HTML과 평문이 따로 놀지 않는다).
ipcMain.handle('clipboard:write-html', async (_evt, payload: { html: string; plain: string }) => {
  try {
    await clipboard.write([
      new ClipboardItem({ 'text/html': String(payload?.html ?? ''), 'text/plain': String(payload?.plain ?? '') }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 최근 파일 열기 — 다이얼로그 없이 경로 직접 읽기. .md만 허용 (임의 파일 읽기 차단)
ipcMain.handle('file:read-path', async (_evt, filePath: string) => {
  try {
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) {
      return { ok: false, error: '.md 파일만 열 수 있습니다.' };
    }
    const content = await fs.readFile(filePath, 'utf8');
    void rememberDir('md', filePath);
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 이미 경로가 확정된 파일에 다이얼로그 없이 덮어쓰기 (Ctrl+S 저장)
// 확장자 allowlist + 절대경로 검증 — preload 노출 API의 방어선 (file:read-path 가드와 대칭)
const SAVE_EXTS = new Set(['.md', '.html', '.json']);

ipcMain.handle(
  'file:save-to-path',
  async (_evt, payload: { filePath: string; content: string }) => {
    try {
      const filePath = payload?.filePath;
      if (
        typeof filePath !== 'string' ||
        !path.isAbsolute(filePath) ||
        !SAVE_EXTS.has(path.extname(filePath).toLowerCase())
      ) {
        return { ok: false, error: '허용되지 않는 저장 경로입니다 (.md/.html/.json 절대경로만).' };
      }
      if (typeof payload.content !== 'string') return { ok: false, error: '저장할 내용이 없습니다.' };
      await writeFileAtomic(filePath, payload.content, { fallbackDirect: true });
      const kind = kindOf(filePath);
      if (kind) void rememberDir(kind, filePath);
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// 합본용 — 이전 주 .md 여러 개를 한 번에 선택. 파일별 읽기 실패는 errors로 모아 반환 (부분 성공 허용)
ipcMain.handle('dialog:open-md-multi', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '합본할 이전 주 .md 선택 (여러 개 가능)',
    defaultPath: await startDir('md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const files: Array<{ filePath: string; content: string }> = [];
  const errors: string[] = [];
  for (const filePath of result.filePaths) {
    try {
      files.push({ filePath, content: await fs.readFile(filePath, 'utf8') });
    } catch (err) {
      errors.push(`${path.basename(filePath)}: ${errMsg(err)}`);
    }
  }
  return { canceled: false, files, errors };
});

ipcMain.handle('dialog:open-json', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '이메일 템플릿 열기',
    defaultPath: await startDir('json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  void rememberDir('json', filePath);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { canceled: false, filePath, content };
  } catch (err) {
    return { canceled: true, error: `파일을 읽을 수 없습니다: ${errMsg(err)}` };
  }
});

ipcMain.handle('shell:open-external', async (_evt, url: string) => {
  // Gmail(임시보관함)·Google 달력만 연다 (피싱/임의 URL 차단) — 허용 목록은 external-url.ts
  if (!isAllowedExternalUrl(url)) return { ok: false, error: '열 수 없는 주소입니다 — Gmail·Google 달력·Notion 주소만 엽니다.' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

// Gmail API 임시보관함(draft) upsert — draftId 있으면 update(404/400 시 create 폴백), 없으면 create (발송 안 함)
ipcMain.handle(
  'gmail:create-draft',
  async (_evt, payload: DraftPayload): Promise<GmailDraftResult> => {
    try {
      const creds = await loadGmailCreds();
      if (!hasGmailDraftScope(creds.scope)) {
        return { ok: false, code: 'scope-missing', message: 'Gmail 권한(스코프)이 부족합니다.' };
      }
      const raw = toBase64Url(buildMimeMessage(payload));
      return await upsertDraft(raw, payload.draftId, {
        getToken: (force) => getAccessToken(creds, force),
      });
    } catch (err) {
      if (err instanceof CredError) return { ok: false, code: 'credentials-missing', message: err.message };
      if (err instanceof OAuthError) return { ok: false, code: err.code, message: err.message };
      return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : '알 수 없는 오류' };
    }
  },
);

// AI 정돈 — Claude API (키 저장·연결 확인·호출)
registerAiIpc();

// 작업일지 — 작업일지 폴더의 [YYYY-MM-DD] 제목.txt 읽기·쓰기
registerWorklogIpc(() => mainWindow);

// 플래너 — 홈 화면의 할 일 저장소(사용자 폴더 아래 planner.json) 읽기·동작 적용
registerPlannerIpc();

// Google 달력 — 확정 일정 읽기·쓰기 (토큰의 권한 범위 안에서)
registerCalendarIpc();

// Notion — 워크스페이스에서 최근 바뀐 페이지와 회의록 읽기 (읽기만, 키는 암호화 저장)
registerNotionIpc();



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
