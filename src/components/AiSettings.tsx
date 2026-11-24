import { useEffect, useMemo, useState } from 'react';
import { isKnownModel, type AiKeyStatus, type AiModelId } from '../../electron/ai-types';
import { MODEL_INFO, loadAiModel, loadModelList, modelChoices, modelLabel, priceText, saveAiModel, saveModelList, type ModelChoice, type ModelList } from '../ai/settings';

/** 모델 목록을 이 시간보다 오래 전에 조회했으면 설정을 열 때 조용히 다시 조회한다 */
const LIST_STALE_MS = 24 * 60 * 60 * 1000;

function optionText(c: ModelChoice): string {
  const hint = isKnownModel(c.id) ? ` — ${MODEL_INFO[c.id].hint}` : '';
  return `${c.label}${hint} (${priceText(c.id)} per 1M)${c.available === false ? ' · 이 키에서 사용 불가' : ''}`;
}

/** 설정 — AI 정돈(Claude API) 키와 모델. 키는 저장만 하고 화면에 다시 보여 주지 않는다 */
export function AiSettings({ mono, open }: { mono: boolean; open: boolean }) {
  const api = typeof window === 'undefined' ? undefined : window.reportApi;
  const [status, setStatus] = useState<AiKeyStatus | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState<AiModelId>(loadAiModel);
  const [list, setList] = useState<ModelList | null>(loadModelList);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const choices = useMemo(() => modelChoices(list, model), [list, model]);

  /** 이 키에서 열린 모델을 조회한다(토큰 비용 없음). quiet면 실패해도 화면에 알리지 않는다 */
  const check = async (quiet = false) => {
    if (!api?.aiModels) return;
    if (!quiet) setChecking(true);
    const res = await api.aiModels().catch((e: unknown) => ({ ok: false as const, code: 'error' as const, message: e instanceof Error ? e.message : String(e) }));
    if (!quiet) setChecking(false);
    if (!res.ok) {
      if (!quiet) setMsg({ ok: false, text: res.message });
      return;
    }
    const next = { at: res.at, models: res.models };
    saveModelList(next);
    setList(next);
    if (quiet) return;
    const { current, others } = modelChoices(next, model);
    const usable = current.filter((c) => c.available).map((c) => c.label.replace(/^Claude /, ''));
    const mine = [...current, ...others].find((c) => c.id === model);
    if (mine?.available === false) {
      setMsg({ ok: false, text: `연결됐지만 이 키에서는 ${modelLabel(model)}을(를) 쓸 수 없습니다. 쓸 수 있는 모델: ${usable.join(' · ') || '없음'}` });
    } else {
      setMsg({ ok: true, text: `연결됨 — 쓸 수 있는 모델: ${usable.join(' · ') || '없음'}${others.length ? ` 외 ${others.length}개` : ''}` });
    }
  };

  const refresh = () =>
    void api?.aiKeyStatus?.().then((s) => {
      setStatus(s);
      const cached = loadModelList();
      if ((s.stored || s.env) && (!cached || Date.now() - cached.at > LIST_STALE_MS)) void check(true);
    });
  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!api?.aiKeyStatus) {
    return (
      <section className="mb-3 rounded-card border border-rule bg-bg p-3">
        <h3 className="mb-1 text-xs font-semibold text-fg">{mono ? '$ ai' : 'AI 정돈 (Claude)'}</h3>
        <p className="text-[11px] text-fg-muted">데스크톱 앱에서 쓸 수 있습니다.</p>
      </section>
    );
  }

  const save = async () => {
    const res = await api.aiSetKey(key);
    if (res.ok) {
      setKey('');
      setMsg({ ok: true, text: '키를 암호화해 저장했습니다. 연결을 확인하는 중…' });
      setStatus(await api.aiKeyStatus());
      await check();
    } else setMsg({ ok: false, text: res.error });
  };
  const clear = async () => {
    await api.aiClearKey();
    setMsg({ ok: true, text: '저장한 키를 지웠습니다.' });
    refresh();
  };

  const keyState = !status
    ? '확인 중…'
    : status.stored
      ? '키 저장됨 (Windows 암호화)'
      : status.env
        ? '환경변수 ANTHROPIC_API_KEY 사용'
        : '키 없음';
  const note = isKnownModel(model)
    ? MODEL_INFO[model].note
    : '주력 목록 밖의 모델입니다. 이 키에서 열려 있고 구조화 출력·effort를 지원하는 모델만 보입니다.';
  const listed = list ? new Date(list.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <section className="mb-3 rounded-card border border-rule bg-bg p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-fg">{mono ? '$ ai' : 'AI 정돈 (Claude)'}</h3>
        <span className="text-[11px] text-fg-muted">{keyState}</span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-fg-muted">
        툴바의 [AI 정돈](Ctrl+Shift+A) — 주간보고 항목, 이메일(고른 서식의 구성·예시에 맞춰), 작업일지 문장을 다듬고, 바뀔 곳을 확인한 뒤 고른 것만 적용합니다. 보내기 전에 IP·URL·메일 주소·전화번호·키 문자열을 가리고, 이미지·표·코드 블록·날짜·라이선스 키 칸·담당자 이름은 보내지 않습니다. 작업일지는 요청자·대화 참여자·직함이 붙은 이름도 가립니다.
      </p>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-[11px] text-fg-soft">API 키</span>
          <input
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.stored ? '새 키로 바꾸려면 입력' : 'sk-ant-…'}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()}
            className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-2 py-1 text-xs text-fg outline-none focus:border-fg"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-[11px] text-fg-soft">모델</span>
          <select
            value={model}
            onChange={(e) => {
              const m = e.target.value as AiModelId;
              setModel(m);
              saveAiModel(m);
              setMsg(null);
            }}
            className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-1.5 py-1 text-xs text-fg outline-none focus:border-fg"
          >
            <optgroup label="지금 모델">
              {choices.current.map((c) => (
                <option key={c.id} value={c.id}>
                  {optionText(c)}
                </option>
              ))}
            </optgroup>
            {choices.others.length > 0 && (
              <optgroup label="이 키에서 열린 그 밖의 모델">
                {choices.others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {optionText(c)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <p className="pl-16 text-[11px] leading-relaxed text-fg-muted">
          {note}
          {listed ? ` 모델 목록 조회: ${listed}.` : ' [연결 확인]을 누르면 이 키에서 쓸 수 있는 모델을 조회합니다.'}
        </p>
      </div>
      {msg && (
        <p className="mt-2 text-[11px]" style={{ color: msg.ok ? 'var(--fg-soft)' : 'var(--stamp-red)' }} role="status">
          {msg.text}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        {status?.stored && (
          <button type="button" onClick={() => void clear()} className="rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken">
            키 지우기
          </button>
        )}
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking || !(status?.stored || status?.env)}
          className="rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken disabled:opacity-40"
        >
          {checking ? '확인 중…' : '연결 확인'}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!key.trim()}
          className="rounded-sharp px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          키 저장
        </button>
      </div>
    </section>
  );
}
