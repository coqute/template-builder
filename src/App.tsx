import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Toaster } from 'sonner';
import { Toolbar } from './components/Toolbar';
import { HelpDrawer } from './components/HelpDrawer';
import { OnboardingModal } from './components/OnboardingModal';
import type { ZoomMode } from './components/HtmlPreview';
import { useUserProfile } from './hooks/useUserProfile';
import { useTheme } from './hooks/useTheme';
import { useDocType } from './hooks/useDocType';
import { useTemplateOverlays } from './email/useTemplateOverlays';
import { readWithFallback, safeSetItem } from './lib/storage';
import { DOC_TYPE_MODULES, getDocTypeModule } from './doctypes';
import { DocTypeHostProvider, type DocIntent, type DocTypeHandlers, type DocTypeHostValue } from './doctypes/DocTypeHost';

const STORAGE_KEY_ZOOM = 'tb:preview-zoom';
const LEGACY_KEY_ZOOM = 'weekly-report-builder:preview-zoom';

function loadZoom(): ZoomMode {
  if (typeof localStorage === 'undefined') return 'fit';
  const v = readWithFallback(STORAGE_KEY_ZOOM, LEGACY_KEY_ZOOM);
  // 50%·75%는 정리됨 — 이전 저장값은 Fit으로
  return v === '100' ? '100' : 'fit';
}

const DOC_TYPE_IDS = DOC_TYPE_MODULES.map((m) => m.id);
const SWITCH_OPTIONS = DOC_TYPE_MODULES.map((m) => ({
  id: m.id,
  label: m.label,
  icon: m.switchIcon,
  hint: m.switchHint,
}));

/**
 * 앱 셸 — 문서 타입별 상태/액션을 모른다. 활성 DocType 모듈을 마운트하고
 * 메뉴/단축키 이벤트를 모듈이 등록한 핸들러로 위임한다. (전역: 도움말·테마·줌·프로필)
 */
export function App() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const { profile, setProfile, needsOnboarding } = useUserProfile();
  const { theme, setTheme } = useTheme();
  const { docType, setDocType } = useDocType(DOC_TYPE_IDS);
  const overlays = useTemplateOverlays();

  const active = getDocTypeModule(docType);
  const Workspace = active.Workspace;

  // ── DocType 호스트: 툴바 슬롯 + 핸들러 레지스트리 ────────────────────────
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const handlersStore = useRef<MutableRefObject<DocTypeHandlers> | null>(null);

  const registerHandlers = useCallback((ref: MutableRefObject<DocTypeHandlers>) => {
    handlersStore.current = ref;
    return () => {
      if (handlersStore.current === ref) handlersStore.current = null;
    };
  }, []);

  // 화면 사이 전달 — 홈에서 "작업일지의 이 사안 열기"처럼, 넘어간 화면이 마운트될 때 한 번 꺼내 쓴다
  const [intent, setIntent] = useState<DocIntent | null>(null);
  const navigate = useCallback(
    (next: string, nextIntent?: DocIntent) => {
      setIntent(nextIntent ?? null);
      setDocType(next);
    },
    [setDocType],
  );
  const clearIntent = useCallback(() => setIntent(null), []);

  const hostValue: DocTypeHostValue = useMemo(
    () => ({ toolbarSlot, registerHandlers, navigate, intent, clearIntent }),
    [toolbarSlot, registerHandlers, navigate, intent, clearIntent],
  );

  useEffect(() => {
    safeSetItem(STORAGE_KEY_ZOOM, zoom);
  }, [zoom]);

  // 네이티브 메뉴 → 활성 모듈 핸들러 위임 (menu:help만 전역)
  useEffect(() => {
    const off = window.reportApi?.onMenu((channel) => {
      if (channel === 'menu:help') {
        setHelpOpen((v) => !v);
        return;
      }
      handlersStore.current?.current.menu[channel]?.();
    });
    return () => off?.();
  }, []);

  // 단축키 → 활성 모듈 위임. F1(도움말)만 전역
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 키 리핏(누른 채 유지) 무시 — Ctrl+Enter(임시보관함 생성) 등 부수효과 단축키의 다중 실행 방지
      if (e.repeat) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) {
        if (e.key === 'F1') {
          e.preventDefault();
          setHelpOpen((v) => !v);
        }
        return;
      }
      const combo =
        e.key === 'Enter' ? 'enter' : `${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const handled = handlersStore.current?.current.shortcut?.(combo) ?? false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="reveal reveal-1">
        <Toolbar
          options={SWITCH_OPTIONS}
          docType={active.id}
          onDocTypeChange={(next) => navigate(next)}
          onToolbarSlot={setToolbarSlot}
          onToggleHelp={() => setHelpOpen((v) => !v)}
          theme={theme}
        />
      </div>

      {/* 활성 문서 타입 워크스페이스 — 모듈이 본문+상태바를 소유 */}
      <div className="min-h-0 flex-1">
        <DocTypeHostProvider value={hostValue}>
          {/* 탭마다 새로 끼우는 틀 — 살짝 커지며 또렷해진다(가운데 미리보기가 열릴 때와 같은 방식) */}
          <div key={active.id} className="tb-page h-full" data-tab={active.id}>
            <Workspace theme={theme} profile={profile} zoom={zoom} onZoomChange={setZoom} templatesVersion={overlays.version} />
          </div>
        </DocTypeHostProvider>
      </div>

      <HelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        profile={profile}
        onProfileChange={setProfile}
        onReloadTemplates={overlays.reload}
        theme={theme}
        onThemeChange={setTheme}
        docType={active.id}
        onCommand={(channel) => {
          setHelpOpen(false);
          handlersStore.current?.current.menu[channel]?.();
        }}
      />
      {needsOnboarding && <OnboardingModal onSubmit={setProfile} />}
      <Toaster
        theme={theme === 'mono' ? 'dark' : 'light'}
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            border: `${theme === 'mono' ? '1.5px' : '1px'} solid var(--rule)`,
            color: 'var(--fg)',
            borderRadius: theme === 'mono' ? '0px' : '6px',
            fontFamily:
              theme === 'mono'
                ? "'JetBrains Mono', 'D2Coding', Consolas, monospace"
                : "'Pretendard Variable', Pretendard, system-ui, sans-serif",
          },
        }}
      />
    </div>
  );
}
