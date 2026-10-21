import { useState } from 'react';
import { AlertTriangle, Loader2, Wand2 } from 'lucide-react';
import { AiProgressLine } from '../../components/AiBusyCard';
import { BTN_GHOST, BTN_SOLID, INPUT, Modal, SOLID_STYLE } from '../../components/Modal';
import { maskedSummary } from '../../ai/review';
import { loadAiModel, modelLabel } from '../../ai/settings';
import { useAiRun } from '../../ai/useAiRun';
import { planBlockFromChat, renderBlocks, type BlockResult } from '../../ai/worklogAi';
import type { Vocabulary } from '../search';

interface Props {
  date: string;
  myName: string;
  vocab: Vocabulary;
  /** 편집기에서 고른 글 — 있으면 대화 칸에 미리 넣는다 */
  initialChat: string;
  onInsert: (text: string, where: 'cursor' | 'end') => void;
  onClose: () => void;
}

const CHANNELS = ['메신저', '카톡', '유선', '현장', '메일'];

/**
 * 대화 → 작업일지 블록 — 붙여 넣은 대화를 Claude로 ■ ▶ - > ※ 블록으로 정리한다.
 * 결과는 바로 넣지 않고 고칠 수 있는 칸에 보여 준다. 전달물(쿼리·스크립트)은 대화 원문과 글자까지 같을 때만 넣는다.
 */
export function BlockFromChatDialog({ date, myName, vocab, initialChat, onInsert, onClose }: Props) {
  const [chat, setChat] = useState(initialChat);
  const [channel, setChannel] = useState('메신저');
  const [requester, setRequester] = useState('');
  const [me, setMe] = useState(myName);
  const [result, setResult] = useState<BlockResult | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ai = useAiRun();
  const busy = !!ai.busy;
  const model = loadAiModel();

  const run = async () => {
    const api = window.reportApi;
    if (!api?.aiComplete) {
      setError('데스크톱 앱에서만 쓸 수 있습니다.');
      return;
    }
    const plan = planBlockFromChat(
      { chat, channel, requester, myName: me, date, knownNames: vocab.requesters.map((r) => r.name) },
      model,
    );
    if (!plan || busy) return;
    setError(null);
    const res = await ai.call(plan.request, '정리하는 중');
    if (!res.ok) {
      // 멈춘 것은 오류가 아니다 — 대화는 그대로 남는다
      if (res.code !== 'canceled') setError(res.message);
      return;
    }
    try {
      const r = renderBlocks(plan, res);
      setResult(r);
      setDraft(r.text);
      if (!r.text.trim()) setError('정리할 작업을 찾지 못했습니다. 대화를 더 붙여 넣거나 요청자·채널을 적어 보세요.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const masked = result ? maskedSummary(result.masked) : '';
  return (
    <Modal
      title="대화 → 작업일지 블록"
      subtitle={
        result
          ? `${modelLabel(result.model)} · 블록 ${result.blocks}개 · 약 $${result.usd.toFixed(3)} · ${Math.max(1, Math.round(result.ms / 1000))}초${masked ? ` · 보내기 전 가림: ${masked}` : ''}`
          : `메신저·카톡 대화, 유선·현장 메모를 붙여 넣으면 ■ ▶ - > ※ 블록으로 정리합니다 (${modelLabel(model)}). IP·URL·메일·전화·키와 이름은 가려서 보냅니다.`
      }
      onClose={() => {
        ai.cancel();
        onClose();
      }}
      width={860}
      labelId="wl-chat-title"
      footer={
        result && draft.trim() ? (
          <>
            <button type="button" className={BTN_GHOST} onClick={() => setResult(null)}>
              대화 고치기
            </button>
            <span className="flex-1" />
            <button type="button" className={BTN_GHOST} onClick={() => onInsert(draft, 'end')}>
              파일 끝에 넣기
            </button>
            <button type="button" className={BTN_SOLID} style={SOLID_STYLE} onClick={() => onInsert(draft, 'cursor')}>
              커서 자리에 넣기
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-[11px] text-fg-muted">
              {ai.busy ? <AiProgressLine startedAt={ai.busy.startedAt} progress={ai.busy.progress} /> : '대화에 없는 사실은 만들지 않습니다. 넣기 전에 결과를 고칠 수 있습니다.'}
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
            <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={busy || !chat.trim()} onClick={() => void run()}>
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> 정리하는 중…
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Wand2 size={13} /> 블록 만들기
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
      {result && draft.trim() ? (
        <div className="space-y-3">
          {(result.warnings.length > 0 || result.questions.length > 0) && (
            <section className="rounded-card border border-rule bg-bg p-3 text-[12.5px]" aria-label="확인할 점">
              <h3 className="mb-1 text-xs font-semibold text-fg">확인할 점</h3>
              <ul className="space-y-0.5 text-fg-soft">
                {result.warnings.map((w, i) => (
                  <li key={`w${i}`} className="flex gap-1">
                    <AlertTriangle size={12} className="mt-1 shrink-0" style={{ color: 'var(--stamp-red)' }} /> {w}
                  </li>
                ))}
                {result.questions.map((q, i) => (
                  <li key={`q${i}`}>· {q}</li>
                ))}
              </ul>
            </section>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-fg">넣을 블록 — 여기서 고친 뒤 넣으세요</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(24, Math.max(8, draft.split('\n').length + 1))}
              className={`${INPUT} font-mono text-[12.5px] leading-relaxed`}
              spellCheck={false}
            />
          </label>
        </div>
      ) : (
        <div className="space-y-3 text-[12.5px]">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
            <label className="block">
              <span className="mb-1 block font-semibold text-fg">채널</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className={INPUT}>
                {[...new Set([...CHANNELS, ...vocab.channels.map((c) => c.name)])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-semibold text-fg">요청자 (비우면 대화에서)</span>
              <input value={requester} onChange={(e) => setRequester(e.target.value)} list="wl-requesters" className={INPUT} placeholder="이름만 — 호칭 없이" />
              <datalist id="wl-requesters">
                {vocab.requesters.slice(0, 80).map((r) => (
                  <option key={r.name} value={r.name} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="mb-1 block font-semibold text-fg">대화 속 내 이름</span>
              <input value={me} onChange={(e) => setMe(e.target.value)} className={INPUT} placeholder="내 메시지를 가려내는 데 씀" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block font-semibold text-fg">대화·메모</span>
            <textarea
              autoFocus
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              rows={16}
              className={`${INPUT} font-mono text-[12.5px] leading-relaxed`}
              placeholder={'[홍길동] [오후 2:31] 프로세스 감시 이벤트가 메일로 안 와요\n[나] [오후 2:40] 이벤트 설정 > 수신 대상에 메일 그룹 추가하시면 됩니다\n…'}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && chat.trim() && !busy) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <span className="mt-1 block text-[11px] text-fg-muted">Ctrl+Enter로 실행 · {chat.length.toLocaleString()}자</span>
            <span className="mt-0.5 block text-[11px] text-fg-muted">
              가리는 이름: 대화 참여자(이름 + 시각으로 시작하는 줄), 직함·님이 붙은 이름, 일지의 요청자, 위에 적은 이름. 호칭 없이 본문에만 나오는 처음 보는 이름은 가려지지 않습니다.
            </span>
          </label>
        </div>
      )}
    </Modal>
  );
}
