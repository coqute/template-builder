import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Wand2 } from 'lucide-react';
import { AiProgressLine } from '../../components/AiBusyCard';
import { BTN_GHOST, BTN_SOLID, INPUT, Modal, SOLID_STYLE } from '../../components/Modal';
import { maskedSummary } from '../../ai/review';
import { loadAiModel, modelLabel } from '../../ai/settings';
import { useAiRun } from '../../ai/useAiRun';
import { applyCompose, composeNames, fieldRole, hasBodyContent, hasPlaceholder, planCompose, renderCompose, type ComposeResult } from '../../ai/emailCompose';
import type { EmailDocState, EmailTemplate } from '../types';

interface Props {
  template: EmailTemplate;
  /** 지금 입력값 — 이미 채워 둔 칸은 그대로 두고, 넣을 때 이 문서에 넣는다 */
  doc: EmailDocState;
  myName: string;
  company: string;
  /** 이 메일에서 앞서 적어 둔 서술 — 창을 닫았다 열어도 남는다 */
  initialText: string;
  onTextChange: (text: string) => void;
  /** 고른 것을 넣은 새 문서와 넣은 곳의 수 */
  onInsert: (next: EmailDocState, count: number) => void;
  onClose: () => void;
}

interface Draft {
  /** 글 칸 — 넣을지, 고친 값 */
  fields: Record<string, { on: boolean; value: string }>;
  /** 표의 빈 칸 — 넣을지 */
  fills: Record<string, boolean>;
  bodyOn: boolean;
  body: string;
}

/**
 * 서술 → 서식 — 편하게 적은 글을 Claude로 이 서식의 칸(제목·도입 문장·이슈·본문·표의 빈 칸)에 맞는 글로 바꾼다.
 * 작업일지의 [대화 → 블록]과 같은 흐름: 결과는 바로 넣지 않고 고칠 수 있는 칸에 보여 준다.
 */
export function ComposeFromTextDialog({ template, doc, myName, company, initialText, onTextChange, onInsert, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [draft, setDraft] = useState<Draft>({ fields: {}, fills: {}, bodyOn: false, body: '' });
  const [error, setError] = useState<string | null>(null);
  const ai = useAiRun();
  const busy = !!ai.busy;
  const model = loadAiModel();
  const names = composeNames(template);
  const bodyLabel = template.bodyLabel ?? '요청내용';

  const { targets, lockedLabels } = useMemo(() => {
    const all = template.sections.flatMap((s) => s.fields);
    const prose = all.filter((f) => fieldRole(f) === 'prose').map((f) => f.label);
    const hasFill = all.some((f) => fieldRole(f) === 'fill');
    return {
      targets: [...prose, ...(template.hasBody ? [bodyLabel] : []), ...(hasFill ? ['표의 빈 칸'] : [])],
      lockedLabels: all.filter((f) => fieldRole(f) === 'locked').map((f) => f.label),
    };
  }, [template, bodyLabel]);

  const changeText = (v: string) => {
    setText(v);
    onTextChange(v);
  };

  const run = async () => {
    const api = window.reportApi;
    if (!api?.aiComplete) {
      setError('데스크톱 앱에서만 쓸 수 있습니다.');
      return;
    }
    const plan = planCompose({ template, doc, text, myName, company }, model);
    if (!plan || busy) return;
    setError(null);
    const res = await ai.call(plan.request, '바꾸는 중');
    if (!res.ok) {
      // 멈춘 것은 오류가 아니다 — 서술은 그대로 남는다
      if (res.code !== 'canceled') setError(res.message);
      return;
    }
    try {
      const r = renderCompose(plan, res);
      if (r.fields.length === 0 && r.fills.length === 0 && !r.body.trim()) {
        setError('서술에서 서식에 넣을 내용을 찾지 못했습니다. 무엇이 어떻게 되는지, 무엇을 묻는지 더 적어 보세요.');
        return;
      }
      setResult(r);
      setDraft({
        fields: Object.fromEntries(r.fields.map((f) => [f.key, { on: true, value: f.value }])),
        fills: Object.fromEntries(r.fills.map((f) => [f.key, true])),
        bodyOn: !!r.body.trim(),
        body: r.body,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 넣을 것 — 고른 글 칸(고친 값), 고른 표 칸, 본문
  const pickedFields: Record<string, string> = {};
  if (result) {
    for (const f of result.fields) if (draft.fields[f.key]?.on && draft.fields[f.key].value.trim()) pickedFields[f.key] = draft.fields[f.key].value;
    for (const f of result.fills) if (draft.fills[f.key]) pickedFields[f.key] = f.value;
  }
  const pickedBody = result && draft.bodyOn && draft.body.trim() ? draft.body : '';
  const count = Object.keys(pickedFields).length + (pickedBody ? 1 : 0);
  const stuck = [...Object.values(pickedFields), pickedBody].some(hasPlaceholder);
  const overBody = !!pickedBody && hasBodyContent(doc.bodyHtml);
  const insert = (bodyMode: 'above' | 'replace') => onInsert(applyCompose(template, doc, { fields: pickedFields, body: pickedBody, bodyMode }), count);

  const setField = (key: string, patch: Partial<{ on: boolean; value: string }>) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: { ...d.fields[key], ...patch } } }));

  const masked = result ? maskedSummary(result.masked) : '';
  return (
    <Modal
      title={`${names.label} — ${template.name}`}
      subtitle={
        result
          ? `${modelLabel(result.model)}${result.fallbackUsed ? ' (대체 모델이 이어 받음)' : ''} · 약 $${result.usd.toFixed(3)} · ${Math.max(1, Math.round(result.ms / 1000))}초${masked ? ` · 보내기 전 가림: ${masked}` : ''}`
          : `편하게 적은 글이나 붙여 넣은 대화를 이 서식의 칸(${targets.join(' · ')})에 맞는 글로 바꿉니다 (${modelLabel(model)}). IP·URL·메일·전화·키와 이름은 가려서 보냅니다.`
      }
      onClose={() => {
        ai.cancel();
        onClose();
      }}
      width={860}
      labelId="mail-compose-title"
      footer={
        result ? (
          <>
            <button type="button" className={BTN_GHOST} onClick={() => setResult(null)}>
              서술 고치기
            </button>
            <span className="min-w-0 flex-1 text-right text-[11px]" style={{ color: 'var(--stamp-red)' }}>
              {stuck ? '되살리지 못한 자리표시(⟦…⟧)가 남아 있습니다 — 지우거나 고쳐야 넣을 수 있습니다.' : ''}
            </span>
            {overBody ? (
              <>
                <button type="button" className={BTN_GHOST} disabled={count === 0 || stuck} onClick={() => insert('replace')}>
                  본문을 바꿔 넣기
                </button>
                <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={count === 0 || stuck} onClick={() => insert('above')}>
                  지금 본문 위에 넣기
                </button>
              </>
            ) : (
              <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={count === 0 || stuck} onClick={() => insert('replace')}>
                {count > 0 ? `서식에 넣기 (${count}곳)` : '넣을 곳을 고르세요'}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-[11px] text-fg-muted">
              {ai.busy ? <AiProgressLine startedAt={ai.busy.startedAt} progress={ai.busy.progress} /> : '서술에 없는 사실은 만들지 않습니다. 넣기 전에 결과를 고칠 수 있습니다.'}
            </span>
            {busy ? (
              <button type="button" className={BTN_GHOST} onClick={ai.cancel}>
                멈추기
              </button>
            ) : (
              <button type="button" className={BTN_GHOST} onClick={onClose}>
                취소
              </button>
            )}
            <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={busy || !text.trim()} onClick={() => void run()}>
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> 바꾸는 중…
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Wand2 size={13} /> {names.make}
                </span>
              )}
            </button>
          </>
        )
      }
    >
      {error && (
        <p className="mb-3 flex items-start gap-1.5 rounded-sharp border border-rule px-2.5 py-2 text-[12px]" style={{ color: 'var(--stamp-red)' }}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      {result ? (
        <div className="space-y-3 text-[12.5px]">
          {(result.warnings.length > 0 || result.gaps.length > 0 || result.questions.length > 0) && (
            <section className="rounded-card border border-rule bg-bg p-3" aria-label="확인할 점">
              <h3 className="mb-1 text-xs font-semibold text-fg">확인할 점</h3>
              <ul className="space-y-0.5 text-fg-soft">
                {result.warnings.map((w, i) => (
                  <li key={`w${i}`} className="flex gap-1">
                    <AlertTriangle size={12} className="mt-1 shrink-0" style={{ color: 'var(--stamp-red)' }} /> {w}
                  </li>
                ))}
                {result.gaps.map((g, i) => (
                  <li key={`g${i}`}>· {g}</li>
                ))}
                {result.questions.map((q, i) => (
                  <li key={`q${i}`}>· {q}</li>
                ))}
              </ul>
            </section>
          )}
          <h3 className="text-xs font-semibold text-fg">넣을 내용 — 여기서 고친 뒤 넣으세요</h3>
          {result.fields.map((f) => {
            const d = draft.fields[f.key];
            const inSubject = doc.subject !== undefined && template.subjectPattern.includes(`{${f.key}}`);
            return (
              <div key={f.key} className="flex gap-2">
                <input type="checkbox" className="mt-2 shrink-0" aria-label={`${f.label} 넣기`} checked={d.on} onChange={(e) => setField(f.key, { on: e.target.checked })} />
                <label className="block min-w-0 flex-1">
                  <span className="mb-0.5 block font-semibold text-fg">{f.label}</span>
                  {f.multiline ? (
                    <textarea value={d.value} onChange={(e) => setField(f.key, { value: e.target.value })} rows={3} className={INPUT} disabled={!d.on} />
                  ) : (
                    <input value={d.value} onChange={(e) => setField(f.key, { value: e.target.value })} className={INPUT} disabled={!d.on} />
                  )}
                  {f.before && <span className="mt-0.5 block text-[11px] text-fg-muted">지금 값: {f.before}</span>}
                  {inSubject && d.on && <span className="mt-0.5 block text-[11px] text-fg-muted">직접 고쳐 둔 메일 제목 대신 이 값이 제목에 쓰입니다.</span>}
                </label>
              </div>
            );
          })}
          {template.hasBody && result.body.trim() && (
            <div className="flex gap-2">
              <input type="checkbox" className="mt-2 shrink-0" aria-label={`${bodyLabel} 넣기`} checked={draft.bodyOn} onChange={(e) => setDraft((d) => ({ ...d, bodyOn: e.target.checked }))} />
              <label className="block min-w-0 flex-1">
                <span className="mb-0.5 block font-semibold text-fg">{bodyLabel}</span>
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  rows={Math.min(22, Math.max(8, draft.body.split('\n').length + 1))}
                  className={`${INPUT} leading-relaxed`}
                  disabled={!draft.bodyOn}
                  spellCheck={false}
                />
                <span className="mt-0.5 block text-[11px] text-fg-muted">
                  빈 줄이 문단을 나눕니다. [이름]과 ■로 시작하는 줄은 굵게 들어갑니다.
                  {hasBodyContent(doc.bodyHtml) ? ' 본문에 이미 내용이 있습니다 — 그 위에 넣거나 바꿀 수 있습니다.' : ''}
                </span>
              </label>
            </div>
          )}
          {result.fills.length > 0 && (
            <fieldset>
              <legend className="mb-1 font-semibold text-fg">표의 빈 칸에 채울 값 — 서술에 그대로 있던 값만</legend>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {result.fills.map((f) => (
                  <li key={f.key}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1 shrink-0" checked={!!draft.fills[f.key]} onChange={(e) => setDraft((d) => ({ ...d, fills: { ...d.fills, [f.key]: e.target.checked } }))} />
                      <span className="min-w-0 break-words">
                        <span className="text-fg-muted">{f.label}</span> <span className="text-fg">{f.value}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-[12.5px]">
          {names.asks.length > 0 && (
            <p className="text-[11.5px] leading-relaxed text-fg-muted">
              <span className="font-semibold text-fg-soft">적으면 좋은 것</span> — {names.asks.join(' · ')}. 순서나 문장은 신경 쓰지 않아도 됩니다.
            </p>
          )}
          <label className="block">
            <span className="mb-1 block font-semibold text-fg">서술</span>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => changeText(e.target.value)}
              rows={15}
              className={`${INPUT} leading-relaxed`}
              placeholder={names.placeholder}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !busy) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <span className="mt-1 block text-[11px] text-fg-muted">Ctrl+Enter로 실행 · {text.length.toLocaleString()}자 · 표에 이미 채워 둔 칸은 그대로 둡니다.</span>
            {lockedLabels.length > 0 && <span className="mt-0.5 block text-[11px] text-fg-muted">읽지도 보내지도 않는 칸: {lockedLabels.join(' · ')} — 직접 넣으세요.</span>}
            <span className="mt-0.5 block text-[11px] text-fg-muted">
              가리는 이름: 대화 참여자(이름 + 시각으로 시작하는 줄), 직함·님이 붙은 이름, 내 이름. 호칭 없이 본문에만 나오는 처음 보는 이름은 가려지지 않습니다.
            </span>
          </label>
        </div>
      )}
    </Modal>
  );
}
