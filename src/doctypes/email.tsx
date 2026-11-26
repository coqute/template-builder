import { useEffect, useMemo, useRef, useState } from 'react';
import { UNDO_MS } from '../lib/undo';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { ClipboardCopy, FileDown, FileText, Mail, Mails, RotateCcw, ScrollText } from 'lucide-react';
import { EmailWorkspace } from '../email/components/EmailWorkspace';
import { EmailStatusBar } from '../email/components/EmailStatusBar';
import { ComposeFromTextDialog } from '../email/components/ComposeFromTextDialog';
import { useEmailDoc } from '../email/useEmailDoc';
import { useEmailState } from '../email/useEmailState';
import { useEmailExport } from '../email/useEmailExport';
import { getTemplates } from '../email/templates';
import { Btn, MoreMenu } from '../components/ToolbarButton';
import { composeNames } from '../ai/emailCompose';
import type { EmailDocState } from '../email/types';
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

  // 서술 → 문의(메일) — 편하게 적은 글을 이 서식의 칸에 맞는 글로 바꿔 넣는다 (작업일지의 대화 → 블록과 같은 흐름)
  const compose = composeNames(emailState.template);
  const [composeOpen, setComposeOpen] = useState(false);
  // 이 메일에 적어 둔 서술 — 창을 닫았다 열어도 남고, 다른 메일로 바꾸면 비운다
  const composeText = useRef('');
  useEffect(() => {
    composeText.current = '';
  }, [emailDoc.docGen]);
  const openCompose = () => {
    if (!emailState.template) {
      toast.error('템플릿을 먼저 고르세요.');
      return;
    }
    setComposeOpen(true);
  };
  const insertComposed = (next: EmailDocState, count: number) => {
    const base = emailDoc.doc;
    setComposeOpen(false);
    emailDoc.loadDoc(next);
    const gen = emailDoc.gen();
    toast.success(`서식에 ${count}곳을 넣었습니다 — 미리보기에서 확인하세요.`, {
      duration: UNDO_MS,
      action: {
        label: '되돌리기',
        onClick: () => {
          // 그 사이 새 이메일·다른 템플릿으로 바꿨으면 넣기 전 내용을 그 메일에 덮어쓰게 된다
          if (emailDoc.gen() !== gen) {
            toast.info('그 사이 다른 메일로 바꿔 되돌리지 않았습니다.');
            return;
          }
          emailDoc.loadDoc(base);
        },
      },
    });
  };

  useRegisterDocTypeHandlers({
    menu: {
      'menu:new': () => resetWithUndo(),
      'menu:draft': () => void emailExport.createDraft(),
      'menu:open': () => void emailExport.openEmail(),
      'menu:save': () => void emailExport.saveEmail(),
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
        case 'shift+b':
          openCompose();
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
      duration: UNDO_MS,
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
              label={compose.label}
              shortcut="Ctrl+Shift+B · 편하게 적은 글을 이 서식의 칸에 맞는 글로 바꿔 채움 (Claude)"
              icon={<ScrollText size={14} />}
              primary
              disabled={!emailState.template}
              onClick={openCompose}
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
      {composeOpen && emailState.template && (
        <ComposeFromTextDialog
          template={emailState.template}
          doc={emailDoc.doc}
          myName={profile.name}
          company={profile.company}
          initialText={composeText.current}
          onTextChange={(t) => {
            composeText.current = t;
          }}
          onInsert={insertComposed}
          onClose={() => setComposeOpen(false)}
        />
      )}
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
