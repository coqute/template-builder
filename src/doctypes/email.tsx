import { createPortal } from 'react-dom';
import { ClipboardCopy, FileDown, FileText, Mail, Mails, Send } from 'lucide-react';
import { EmailWorkspace } from '../email/components/EmailWorkspace';
import { EmailStatusBar } from '../email/components/EmailStatusBar';
import { useEmailDoc } from '../email/useEmailDoc';
import { useEmailState } from '../email/useEmailState';
import { useEmailExport } from '../email/useEmailExport';
import { Btn } from '../components/ToolbarButton';
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
  const emailExport = useEmailExport(emailDoc.doc, emailState.rendered, emailDoc.loadDoc);

  useRegisterDocTypeHandlers({
    menu: {
      'menu:open': () => void emailExport.openEmail(),
      'menu:save': () => void emailExport.saveEmail(),
      'menu:copy-html': () => void emailExport.copyEmailHtml(),
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
          void emailExport.copyEmailHtml();
          return true;
        case 'enter':
          void emailExport.createDraft();
          return true;
        default:
          return false;
      }
    },
  });

  const disabled = !emailState.rendered;

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            <Btn
              label="열기"
              shortcut="Ctrl+O"
              icon={<FileText size={14} />}
              onClick={() => void emailExport.openEmail()}
            />
            <Btn
              label="저장"
              shortcut="Ctrl+S"
              icon={<FileDown size={14} />}
              onClick={() => void emailExport.saveEmail()}
            />
            <Btn
              label="HTML 복사"
              shortcut="Ctrl+Shift+C"
              icon={<ClipboardCopy size={14} />}
              disabled={disabled}
              onClick={() => void emailExport.copyEmailHtml()}
            />
            <Btn
              label="Gmail 작성"
              icon={<Send size={14} />}
              disabled={disabled}
              onClick={() => void emailExport.composeInGmail()}
            />
            <Btn
              label="임시보관함"
              shortcut="Ctrl+Enter · 이미지 인라인 포함"
              icon={<Mails size={14} />}
              primary
              disabled={disabled}
              onClick={() => void emailExport.createDraft()}
            />
          </>,
          toolbarSlot,
        )}
      <div className="flex h-full flex-col">
        <main className="min-h-0 flex-1">
          <EmailWorkspace
            template={emailState.template}
            doc={emailDoc.doc}
            bodyKey={emailDoc.bodyKey}
            rendered={emailState.rendered}
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
  switchHint: '반복 이메일 템플릿 → Gmail 작성',
  badge: '폼 → 이메일',
  Workspace: EmailModuleWorkspace,
};
