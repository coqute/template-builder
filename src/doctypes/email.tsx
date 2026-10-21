import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { ClipboardCopy, FileDown, FileText, Mail, Mails, RotateCcw, Wand2 } from 'lucide-react';
import { EmailWorkspace } from '../email/components/EmailWorkspace';
import { EmailStatusBar } from '../email/components/EmailStatusBar';
import { useEmailDoc } from '../email/useEmailDoc';
import { useEmailState } from '../email/useEmailState';
import { useEmailExport } from '../email/useEmailExport';
import { getTemplates } from '../email/templates';
import { Btn, MoreMenu } from '../components/ToolbarButton';
import { useAiTidy } from '../ai/useAiTidy';
import { applyEmail, planEmailTidy, reviewEmail } from '../ai/emailTidy';
import { loadAiModel } from '../ai/settings';
import { useDocTypeHost, useRegisterDocTypeHandlers } from './DocTypeHost';
import type { DocTypeModule, DocTypeWorkspaceProps } from './registry';

function EmailModuleWorkspace({
  theme,
  profile,
  zoom,
  onZoomChange,
  templatesVersion,
}: DocTypeWorkspaceProps) {
  const { toolbarSlot } = useDocTypeHost();
  const emailDoc = useEmailDoc();
  const emailState = useEmailState(emailDoc.doc, profile, templatesVersion);
  const emailExport = useEmailExport(emailDoc.doc, emailState.rendered, emailDoc.loadDoc, emailDoc.docGen);
  // 드롭다운 목록 — 프로필/오버레이 버전이 바뀔 때만 재해석 (키 입력마다 전체 템플릿을 다시 풀지 않도록)
  const templates = useMemo(() => getTemplates(profile), [profile, templatesVersion]);

  // 자유 본문(hasBody) 템플릿 = 이미지 삽입 가능 → HTML 복사는 붙여넣기 시 이미지가 누락될 수 있어
  // 감춘다. 이미지가 인라인으로 확실히 포함되는 임시보관함(draft) 경로로 통일. 본문 없는 템플릿만 HTML 복사 허용.
  const allowHtmlCopy = !emailState.template?.hasBody;
  const weeklyOnly = () => toast.info('주간보고서 모드 전용 기능입니다.');

  // AI 정돈 — 지금 입력값을 기준으로 계획하고, 적용 직전에 입력값이 그대로인지 확인한다
  const ai = useAiTidy();
  const docRef = useRef(emailDoc.doc);
  docRef.current = emailDoc.doc;
  const tidyWithAi = async () => {
    const template = emailState.template;
    if (!template) {
      toast.error('템플릿을 먼저 고르세요.');
      return;
    }
    const base = emailDoc.doc;
    await ai.run({
      title: `AI 정돈 — ${template.name}`,
      empty: '다듬을 내용이 없습니다. 제목·이슈·요청내용을 쓴 뒤 실행하세요.',
      plan: () => planEmailTidy(template, base, loadAiModel()),
      request: (p) => p.request,
      review: (p, res) => reviewEmail(p, res),
      apply: (_p, review, picked) => {
        if (docRef.current !== base) {
          toast.error('정돈하는 동안 입력값이 바뀌어 적용하지 않았습니다. 다시 실행하세요.');
          return;
        }
        emailDoc.loadDoc(applyEmail(base, review, picked));
        const gen = emailDoc.gen();
        toast.success(`${picked.size}곳을 다듬었습니다.`, {
          duration: 8000,
          action: {
            label: '되돌리기',
            onClick: () => {
              // 그 사이 새 이메일·다른 템플릿으로 바꿨으면 정돈 전 내용을 그 메일에 덮어쓰게 된다
              if (emailDoc.gen() !== gen) {
                toast.info('그 사이 다른 메일로 바꿔 되돌리지 않았습니다.');
                return;
              }
              emailDoc.loadDoc(base);
            },
          },
        });
      },
    });
  };

  useRegisterDocTypeHandlers({
    menu: {
      'menu:new': () => resetWithUndo(),
      'menu:draft': () => void emailExport.createDraft(),
      'menu:open': () => void emailExport.openEmail(),
      'menu:save': () => void emailExport.saveEmail(),
      'menu:load-sample': weeklyOnly,
      'menu:import-gmail': weeklyOnly,
      'menu:copy-html': () =>
        allowHtmlCopy
          ? void emailExport.copyEmailHtml()
          : toast.info('이 서식은 이미지가 포함될 수 있어 [임시보관함](Ctrl+Enter)으로 작성하세요.'),
    },
    shortcut: (combo) => {
      switch (combo) {
        case 's':
          void emailExport.saveEmail();
          return true;
        case 'o':
          void emailExport.openEmail();
          return true;
        case 'shift+c':
          if (allowHtmlCopy) void emailExport.copyEmailHtml();
          else toast.info('이 서식은 이미지가 포함될 수 있어 [임시보관함](Ctrl+Enter)으로 작성하세요.');
          return true;
        case 'enter':
          void emailExport.createDraft();
          return true;
        case 'shift+a':
          if (!ai.busy) void tidyWithAi();
          return true;
        default:
          return false;
      }
    },
  });

  const disabled = !emailState.rendered;
  const draftDisabled = disabled || emailExport.busy;

  /** 새 이메일 — 입력값을 잃지 않도록 토스트 [되돌리기]로 직전 문서 복원 */
  function resetWithUndo() {
    const prev = emailDoc.doc;
    emailDoc.resetDoc();
    const gen = emailDoc.gen();
    toast.success('새 이메일 — 현재 템플릿의 기본값으로 초기화했습니다.', {
      duration: 8000,
      action: {
        label: '되돌리기',
        onClick: () => {
          if (emailDoc.gen() !== gen) {
            toast.info('그 사이 다른 메일로 바꿔 되돌리지 않았습니다.');
            return;
          }
          emailDoc.loadDoc(prev, { fresh: true });
        },
      },
    });
  }

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            {/* 본문 없는 서식만 HTML 복사 — 이미지가 들어갈 수 있는 서식은 붙여넣기 시 이미지가 누락될 수 있어 임시보관함으로 통일 */}
            {allowHtmlCopy && (
              <Btn
                label="HTML 복사"
                shortcut="Ctrl+Shift+C"
                icon={<ClipboardCopy size={14} />}
                disabled={disabled}
                onClick={() => void emailExport.copyEmailHtml()}
              />
            )}
            <Btn
              label="AI 정돈"
              shortcut="Ctrl+Shift+A · 제목·이슈·요청내용을 Claude로 다듬고 바뀔 곳을 확인한 뒤 적용"
              icon={<Wand2 size={14} />}
              disabled={ai.busy}
              onClick={() => void tidyWithAi()}
            />
            <Btn
              label={emailExport.busy ? '생성 중…' : '임시보관함'}
              shortcut="Ctrl+Enter · 이미지 인라인 포함"
              icon={<Mails size={14} />}
              primary
              disabled={draftDisabled}
              onClick={() => void emailExport.createDraft()}
            />
            <MoreMenu
              items={[
                {
                  label: '새 이메일',
                  shortcut: 'Ctrl+N',
                  icon: <RotateCcw size={13} />,
                  hint: '현재 템플릿의 기본값으로 초기화 (되돌리기 가능)',
                  onClick: resetWithUndo,
                },
                {
                  label: '입력값 열기 (.json)',
                  shortcut: 'Ctrl+O',
                  icon: <FileText size={13} />,
                  onClick: () => void emailExport.openEmail(),
                },
                {
                  label: '입력값 저장 (.json)',
                  shortcut: 'Ctrl+S',
                  icon: <FileDown size={13} />,
                  onClick: () => void emailExport.saveEmail(),
                },
              ]}
            />
          </>,
          toolbarSlot,
        )}
      {ai.view}
      <div className="flex h-full flex-col">
        <main className="min-h-0 flex-1">
          <EmailWorkspace
            template={emailState.template}
            templates={templates}
            doc={emailDoc.doc}
            bodyKey={emailDoc.bodyKey}
            rendered={emailState.rendered}
            error={emailState.error}
            onTemplateChange={emailDoc.setTemplateId}
            onField={emailDoc.setField}
            onBody={emailDoc.setBody}
            onSubject={emailDoc.setSubject}
            onRegenerateSubject={emailDoc.regenerateSubject}
            zoom={zoom}
            onZoomChange={onZoomChange}
            theme={theme}
          />
        </main>
        <EmailStatusBar
          validation={emailState.validation}
          recipientHint={emailState.template?.recipientHint}
          error={emailState.error}
          theme={theme}
        />
      </div>
    </>
  );
}

export const emailModule: DocTypeModule = {
  id: 'email',
  label: '이메일',
  switchIcon: <Mail size={12} />,
  switchHint: '반복 이메일 → Gmail 임시보관함',
  Workspace: EmailModuleWorkspace,
};
