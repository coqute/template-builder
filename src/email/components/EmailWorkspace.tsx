import { useState } from 'react';
import { Allotment } from 'allotment';
import { toast } from 'sonner';
import { FileText, PencilLine, RotateCcw } from 'lucide-react';
import { HtmlPreview, ZoomToggle, type ZoomMode } from '../../components/HtmlPreview';
import { getTemplates } from '../templates';
import type { EmailRenderResult, EmailTemplate, EmailDocState } from '../types';
import { EmailFieldForm } from './EmailFieldForm';
import { RichBodyEditor } from './RichBodyEditor';
import type { Theme } from '../../hooks/useTheme';

interface Props {
  template?: EmailTemplate;
  doc: EmailDocState;
  bodyKey: number;
  rendered?: EmailRenderResult;
  onTemplateChange: (id: string) => void;
  onField: (key: string, value: string) => void;
  onBody: (html: string) => void;
  onSubject: (subject: string) => void;
  onRegenerateSubject: () => void;
  zoom: ZoomMode;
  onZoomChange: (z: ZoomMode) => void;
  theme: Theme;
}

const EMAIL_CANVAS_WIDTH = 680;

export function EmailWorkspace({
  template,
  doc,
  bodyKey,
  rendered,
  onTemplateChange,
  onField,
  onBody,
  onSubject,
  onRegenerateSubject,
  zoom,
  onZoomChange,
  theme,
}: Props) {
  const isMono = theme === 'mono';
  const [leftTab, setLeftTab] = useState<'fields' | 'body'>('fields');
  if (!template) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        템플릿을 찾을 수 없습니다.
      </div>
    );
  }
  // hasBody=false 템플릿(출입정보 등)은 본문 탭 없음 → 입력항목 강제
  const effectiveTab: 'fields' | 'body' = template.hasBody ? leftTab : 'fields';

  return (
    <div className="flex h-full flex-col">
      {/* 컴포즈 헤더 — 템플릿 선택 + 제목 직접 입력 */}
      <div className="flex shrink-0 flex-nowrap items-center gap-2 border-b border-rule bg-bg-deep px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-fg-muted">템플릿</span>
        <select
          value={template.id}
          onChange={(e) => onTemplateChange(e.target.value)}
          className="w-40 shrink-0 rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        >
          {getTemplates().map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-rule" />
        <span className="shrink-0 text-[11px] font-medium text-fg-muted">제목</span>
        <input
          type="text"
          value={doc.subject ?? ''}
          onChange={(e) => onSubject(e.target.value)}
          placeholder={rendered?.subject || '제목을 입력하세요'}
          className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={onRegenerateSubject}
          title="현재 항목으로 제목 자동 생성"
          className="flex shrink-0 items-center gap-1 rounded-sharp border border-rule px-1.5 py-1 text-[11px] text-fg-soft transition hover:bg-bg-sunken hover:text-fg"
        >
          <RotateCcw size={12} />
          <span className="hidden lg:inline">자동</span>
        </button>
        {template.recipientHint && (
          <span
            className="hidden shrink-0 rounded-sharp border border-rule px-2 py-0.5 text-[10px] text-fg-muted xl:inline-block"
            title={
              template.recipientCc?.length
                ? `받는사람 ${template.recipientHint} · 참조 ${template.recipientCc.join(', ')}`
                : `받는사람 ${template.recipientHint}`
            }
          >
            {template.recipientHint}
            {template.recipientCc?.length ? ` · CC ${template.recipientCc.length}` : ''}
          </span>
        )}
      </div>

      <main className="min-h-0 flex-1">
        <Allotment defaultSizes={[44, 56]}>
          {/* 좌측: [입력항목]↔[본문] 탭 — 선택 탭이 전체 높이 사용 */}
          <Allotment.Pane minSize={360}>
            <div className="flex h-full flex-col">
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-rule bg-bg-deep px-2">
                <TabBtn
                  active={effectiveTab === 'fields'}
                  onClick={() => setLeftTab('fields')}
                  icon={<FileText size={12} />}
                  label={isMono ? 'fields' : '입력항목'}
                />
                {template.hasBody && (
                  <TabBtn
                    active={effectiveTab === 'body'}
                    onClick={() => setLeftTab('body')}
                    icon={<PencilLine size={12} />}
                    label={template.bodyLabel ?? (isMono ? 'body' : '본문')}
                  />
                )}
                {effectiveTab === 'body' && (
                  <span className="ml-1 hidden truncate text-[10px] text-fg-faint lg:inline">
                    이미지·표·글머리 자유 작성
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {effectiveTab === 'fields' ? (
                  <div className="scrollbar-thin h-full overflow-auto px-3 py-2.5">
                    <EmailFieldForm template={template} values={doc.fieldValues} onChange={onField} />
                  </div>
                ) : (
                  <RichBodyEditor
                    key={bodyKey}
                    initialHtml={doc.bodyHtml}
                    onChange={onBody}
                    placeholder={template.bodyPlaceholder}
                    onImageOversize={() =>
                      toast.warning('이미지가 1.5MB를 초과합니다. Gmail에서 직접 첨부를 권장합니다.')
                    }
                  />
                )}
              </div>
            </div>
          </Allotment.Pane>

          {/* 우측: 이메일 미리보기 */}
          <Allotment.Pane minSize={380}>
            <div className="flex h-full flex-col">
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-rule bg-bg-deep px-3 text-[11px]">
                <span className="text-fg-muted">{isMono ? 'PREVIEW.eml' : '이메일 미리보기'}</span>
                <ZoomToggle zoom={zoom} onZoomChange={onZoomChange} />
              </div>
              <div className="h-[calc(100%-32px)]">
                <HtmlPreview
                  html={rendered?.html ?? ''}
                  zoom={zoom}
                  canvasWidth={EMAIL_CANVAS_WIDTH}
                  emptyHint="템플릿을 선택하고 항목을 입력하면 이메일이 나타납니다."
                />
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>
      </main>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex shrink-0 items-center gap-1 rounded-sharp px-2 py-1 text-[11px] leading-none transition',
        active ? 'font-semibold' : 'text-fg-soft hover:text-fg',
      ].join(' ')}
      style={active ? { background: 'var(--accent)', color: 'var(--bg)' } : undefined}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
