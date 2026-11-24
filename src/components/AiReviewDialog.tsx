import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { ReviewChange, ReviewData } from '../ai/review';
import { maskedSummary } from '../ai/review';
import { diffWords } from '../ai/diff';
import { modelLabel } from '../ai/settings';
import { sanitizeBodyHtml } from '../email/sanitize';

interface Props {
  title: string;
  review: ReviewData;
  onApply: (picked: Set<string>) => void;
  onClose: () => void;
}

/** AI 정돈 확인 창 — 바뀔 곳을 묶음별로 보여 주고, 고른 것만 적용한다 */
export function AiReviewDialog({ title, review, onApply, onClose }: Props) {
  const applicable = review.changes.filter((c) => c.ok);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(applicable.map((c) => c.id)));
  const applyRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    applyRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const m = new Map<string, ReviewChange[]>();
    for (const c of review.changes) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [review.changes]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = picked.size === applicable.length;
  const masked = maskedSummary(review.masked);
  const seconds = Math.max(1, Math.round(review.ms / 1000));

  return (
    <div className="tb-scrim fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-review-title"
        className="tb-pop flex max-h-[86vh] w-[min(820px,100%)] flex-col rounded-card border border-rule-strong bg-bg-elevated"
        style={{ boxShadow: 'var(--shadow-pop)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-3">
          <div className="min-w-0">
            <h2 id="ai-review-title" className="text-sm font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              {modelLabel(review.model)}
              {review.fallbackUsed ? ' (대체 모델이 이어 받음)' : ''} · 입력 {review.usage.input.toLocaleString()} ·
              출력 {review.usage.output.toLocaleString()} 토큰{review.usage.thinking ? `(생각 ${review.usage.thinking.toLocaleString()} 포함)` : ''}
              {(review.usage.parts?.length ?? 1) > 1 && !review.fallbackUsed ? ' · 한도를 올려 다시 요청함' : ''} · 약 ${review.usd.toFixed(3)} · {seconds}초
              {masked ? ` · 보내기 전 가림: ${masked}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기 (Esc)" className="rounded-sharp p-1 text-fg-muted hover:bg-bg-sunken hover:text-fg">
            <X size={16} />
          </button>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {review.notes.length > 0 && (
            <section className="mb-4 rounded-card border border-rule bg-bg p-3" aria-label="확인할 점">
              <h3 className="mb-1.5 text-xs font-semibold text-fg">확인할 점 — 직접 판단해 고치세요</h3>
              <ul className="space-y-1 text-[12.5px] leading-relaxed text-fg-soft">
                {review.notes.map((n, i) => (
                  <li key={i}>
                    {n.group && <span className="mr-1.5 font-semibold text-fg">{n.group}</span>}
                    {n.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {review.changes.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-fg-muted">다듬을 곳이 없습니다. 지금 내용 그대로 두세요.</p>
          ) : (
            groups.map(([group, list]) => (
              <section key={group} className="mb-4">
                <h3 className="mb-1.5 text-[12.5px] font-semibold text-fg">{group}</h3>
                <ul className="divide-y divide-[var(--rule)] rounded-card border border-rule">
                  {list.map((c) => (
                    <li key={c.id} className={`flex gap-3 px-3 py-2 ${c.ok ? '' : 'opacity-70'}`}>
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        aria-label={`${c.label} 적용`}
                        checked={c.ok && picked.has(c.id)}
                        disabled={!c.ok}
                        onChange={() => toggle(c.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 text-[11px] font-semibold text-fg-muted">{c.label}</div>
                        {c.html ? (
                          <HtmlCompare before={c.before} after={c.after} />
                        ) : (
                          <TextCompare before={c.before} after={c.after} />
                        )}
                        {!c.ok && (
                          <div className="mt-1 flex items-center gap-1 text-[11.5px]" style={{ color: 'var(--stamp-red)' }}>
                            <AlertTriangle size={12} aria-hidden="true" /> 적용하지 않음 — {c.reason}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-rule px-5 py-3">
          {applicable.length > 1 && (
            <button
              type="button"
              onClick={() => setPicked(allOn ? new Set() : new Set(applicable.map((c) => c.id)))}
              className="rounded-sharp border border-rule px-2.5 py-1 text-[11.5px] text-fg-soft hover:bg-bg-sunken"
            >
              {allOn ? '모두 해제' : '모두 선택'}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-sharp border border-rule px-3 py-1.5 text-xs text-fg-soft hover:bg-bg-sunken">
            취소
          </button>
          <button
            ref={applyRef}
            type="button"
            disabled={picked.size === 0}
            onClick={() => onApply(picked)}
            className="rounded-sharp px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--bg)' }}
          >
            {picked.size > 0 ? `고른 ${picked.size}곳 적용` : '적용할 곳을 고르세요'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 글 비교 — 지운 낱말은 취소선, 더한 낱말은 진하게 */
function TextCompare({ before, after }: { before: string; after: string }) {
  const parts = diffWords(before, after);
  return (
    <div className="space-y-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">
      {before && (
        <div className="text-fg-muted">
          {parts
            .filter((p) => p.t !== 'add')
            .map((p, i) =>
              p.t === 'del' ? (
                <del key={i} className="decoration-1" style={{ color: 'var(--fg-soft)' }}>
                  {p.s}
                </del>
              ) : (
                <span key={i}>{p.s}</span>
              ),
            )}
        </div>
      )}
      <div className="text-fg">
        {parts
          .filter((p) => p.t !== 'del')
          .map((p, i) =>
            p.t === 'add' ? (
              <mark key={i} className="rounded-sharp px-0.5 font-semibold text-fg" style={{ background: 'var(--selection)' }}>
                {p.s}
              </mark>
            ) : (
              <span key={i}>{p.s}</span>
            ),
          )}
      </div>
    </div>
  );
}

/** 본문 비교 — 지금 / 다듬은 본문을 나란히 (메일에 나갈 모양 그대로) */
function HtmlCompare({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { label: '지금', html: before },
        { label: '다듬은 본문', html: after },
      ].map((col) => (
        <div key={col.label} className="min-w-0">
          <div className="mb-0.5 text-[11px] text-fg-muted">{col.label}</div>
          <div
            className="email-body-editor scrollbar-thin max-h-[42vh] overflow-y-auto rounded-sharp border border-rule bg-bg p-2 text-[12.5px] leading-relaxed text-fg"
            // 두 쪽 모두 새니타이즈를 거친 본문 — 확인 창에서도 한 번 더 거른다
            dangerouslySetInnerHTML={{ __html: sanitizeBodyHtml(col.html) }}
          />
        </div>
      ))}
    </div>
  );
}
