import { useState } from 'react';
import { Allotment } from 'allotment';
import { toast } from 'sonner';
import { AlertCircle, FileText, PencilLine, RotateCcw } from 'lucide-react';
import { HtmlPreview, ZoomToggle, type ZoomMode } from '../../components/HtmlPreview';
import type { EmailRenderResult, EmailTemplate, EmailDocState } from '../types';
import { EmailFieldForm } from './EmailFieldForm';
import { RichBodyEditor } from './RichBodyEditor';
import type { Theme } from '../../hooks/useTheme';

interface Props {
  /** 현재 doc.templateId가 해석된 템플릿 — 오버레이 미로드/삭제 시 undefined */
  template?: EmailTemplate;
  /** 드롭다운 목록 (호출부가 프로필·오버레이 버전으로 memo) */
  templates: EmailTemplate[];
  doc: EmailDocState;
  bodyKey: number;
  rendered?: EmailRenderResult;
  /** 템플릿 해석/렌더 실패 메시지 */
  error?: string;
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
  templates,
  doc,
  bodyKey,
  rendered,
  error,
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
  // hasBody=false 템플릿(출입정보 등)은 본문 탭 없음 → 입력항목 강제
  const effectiveTab: 'fields' | 'body' = template?.hasBody ? leftTab : 'fields';
  const templateMissing = !templates.some((t) => t.id === doc.templateId);

  return (
    <div className="flex h-full flex-col">
      {/* 컴포즈 헤더 — 템플릿 선택 + 제목 직접 입력.
          템플릿을 해석하지 못해도 항상 렌더 — 오버레이 reload로 현재 템플릿이 사라졌을 때
          드롭다운까지 사라져 복구 경로가 없던 고착 상태 방지 */}
      <div className="flex shrink-0 flex-nowrap items-center gap-2 border-b border-rule bg-bg-deep px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-fg-muted">템플릿</span>
        <select
          value={doc.templateId}
          onChange={(e) => onTemplateChange(e.target.value)}
          className="w-40 shrink-0 rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-fg"
        >
          {templateMissing && (
            <option value={doc.templateId} disabled>
              (찾을 수 없음) {doc.templateId}
            </option>
          )}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-rule" />
        <span className="shrink-0 text-[11px] font-medium text-fg-muted">제목</span>
        {/* 자동 모드(직접 편집 전): 입력값이 패턴에 실시간 반영된 제목을 그대로 표시.
            타이핑하면 수동 고정, 전부 지우면 자동 복귀 */}
        <input
          type="text"
          value={doc.subject ?? rendered?.subject ?? ''}
          onChange={(e) => onSubject(e.target.value)}
          placeholder="제목을 입력하세요"
          title={
            doc.subject === undefined
              ? '자동 — 문의 주제·고객사 입력이 제목에 그대로 반영됩니다. 직접 수정하면 고정됩니다.'
              : '직접 입력한 제목 (전부 지우면 자동으로 복귀)'
          }
          className={[
            'min-w-0 flex-1 rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs outline-none focus:border-fg',
            doc.subject === undefined ? 'text-fg-soft' : 'text-fg',
          ].join(' ')}
        />
        <span
          className="shrink-0 rounded-sharp px-1.5 py-0.5 text-[10px] font-medium"
          style={
            doc.subject === undefined
              ? { background: 'var(--accent)', color: 'var(--bg)' }
              : { border: '1px solid var(--rule)', color: 'var(--fg-muted)' }
          }
          title={doc.subject === undefined ? '입력값이 제목에 실시간 반영 중' : '직접 입력한 제목으로 고정됨'}
        >
          {doc.subject === undefined ? '자동' : '수동'}
        </span>
        {doc.subject !== undefined && (
          <button
            type="button"
            onClick={onRegenerateSubject}
            title="자동 생성으로 되돌리기"
            className="flex shrink-0 items-center gap-1 rounded-sharp border border-rule px-1.5 py-1 text-[11px] text-fg-soft transition hover:bg-bg-sunken hover:text-fg"
          >
            <RotateCcw size={12} />
            <span className="hidden lg:inline">자동으로</span>
          </button>
        )}
        {template?.recipientHint && (
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

      {!template ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-fg-muted">
          <AlertCircle size={20} style={{ color: 'var(--stamp-red)' }} />
          <p className="text-sm text-fg">템플릿을 찾을 수 없습니다: <code className="font-mono">{doc.templateId}</code></p>
          <p className="text-[11px] leading-relaxed">
            {error ?? '팀/개인 템플릿이 아직 로드되지 않았거나 폴더에서 제거되었습니다.'}
            <br />
            위 드롭다운에서 다른 템플릿을 고르거나, 설정(F1)에서 템플릿 폴더를 확인하고 [다시 불러오기]를 누르세요.
            현재 입력값은 그대로 보존됩니다.
          </p>
        </div>
      ) : (
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
                      presets={template.bodyPresets}
                      onImageOversize={() =>
                        toast.warning('이미지가 1.5MB를 초과합니다. Gmail에서 직접 첨부를 권장합니다.')
                      }
                      onImageError={(reason) => toast.error(`이미지를 넣지 못했습니다: ${reason}`)}
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
                    emptyHint={error ? `렌더 오류: ${error}` : '템플릿을 선택하고 항목을 입력하면 이메일이 나타납니다.'}
                  />
                </div>
              </div>
            </Allotment.Pane>
          </Allotment>
        </main>
      )}
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
