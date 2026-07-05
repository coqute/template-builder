import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';
import type { DocType } from '../hooks/useDocType';
import { getTemplates } from '../email/templates';
import { buildGreeting, type UserProfile } from '../email/profile';

interface Props {
  open: boolean;
  onClose: () => void;
  profile: UserProfile;
  onProfileChange: (next: UserProfile) => void;
  theme: Theme;
  docType: DocType;
}

const ROWS: Array<{ token: string; tone: string; description: string; example: string }> = [
  {
    token: '@PREV',
    tone: 'tok-week',
    description: '보고 대상 주 (지난 주 — 한 일). 제목 자동 생성',
    example: '@PREV 2026-04-27 ~ 2026-05-03',
  },
  {
    token: '@CURRENT',
    tone: 'tok-next',
    description: '작성 시점 주 (이번 주 — 앞으로 할 일). 본문 □ Date 줄',
    example: '@CURRENT 2026-05-04 ~ 2026-05-08',
  },
  {
    token: '@AUTHOR',
    tone: 'tok-author',
    description: '작성자명 (제목에 사용) — 내 프로필의 이름이 기본값',
    example: '@AUTHOR 홍길동',
  },
  {
    token: '#',
    tone: 'tok-day',
    description: '일자 행 시작',
    example: '# 2026-04-27(월)',
  },
  {
    token: '@LOC',
    tone: 'tok-loc',
    description: '지원장소 컬럼 — slash로 멀티라인',
    example: '@LOC 남산 데이터센터',
  },
  {
    token: '@CUS',
    tone: 'tok-loc',
    description: '고객사 / 작업구분 컬럼 — 단일 텍스트',
    example: '@CUS 남산 IDC',
  },
  {
    token: '@SUM',
    tone: 'tok-client',
    description: '작업 요약 — 내용 셀의 굵은 상위 헤더, 1)/-/<-/-> 본문의 분류',
    example: '@SUM [ABZ+] (이영희/메일) 작업 설명',
  },
  {
    token: '1)',
    tone: 'tok-num',
    description: '번호 매김 작업 + 하위 - 항목',
    example: '1) 관리 콘솔 설치\n- 서비스 실행 확인',
  },
  {
    token: '<- / ->',
    tone: 'tok-qaq',
    description: '문의(<-) + 답변(->) 패턴',
    example: '<- 문의\n-> 답변',
  },
  {
    token: '-',
    tone: 'tok-dash',
    description: '단순 bullet 또는 1) 하위 항목',
    example: '- 스크립트 수정 및 공유',
  },
  {
    token: '>',
    tone: 'tok-note',
    description: '보조 설명(노트) — 들여쓰기 + 회색으로 표시. 사용방법·결과·세부 케이스 부연',
    example: '1) 설정 일괄 적용 테스트\n- pid 단위 적용\n> schedule 설정 모두 정상 확인',
  },
  {
    token: '@HOLIDAY',
    tone: 'tok-holiday',
    description: '휴무일 — 행 전체 빨간 배경 강조',
    example: '# 2026-05-01(금)\n@HOLIDAY 근로자의 날',
  },
];

export function HelpDrawer({ open, onClose, profile, onProfileChange, theme, docType }: Props) {
  const [draft, setDraft] = useState<UserProfile>(profile);

  useEffect(() => {
    setDraft(profile);
  }, [profile, open]);

  const isMono = theme === 'mono';
  const isEmail = docType === 'email';
  const dirty =
    draft.name !== profile.name || draft.email !== profile.email || draft.company !== profile.company;

  return (
    <div
      className={[
        'pointer-events-none fixed inset-0 z-30 transition',
        open ? 'pointer-events-auto bg-black/40' : 'opacity-0',
      ].join(' ')}
      onClick={onClose}
    >
      <aside
        className={[
          'absolute right-0 top-0 h-full w-[380px] border-l border-rule bg-bg-elevated transition-transform',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ boxShadow: 'var(--shadow)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-rule px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">
              {isMono ? '$ help' : '키워드 가이드'}
            </h2>
            <p className="text-[11px] text-fg-muted">
              {isMono ? '> press F1 to toggle' : 'F1로 다시 열고 닫을 수 있습니다.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sharp p-1 text-fg-muted hover:bg-bg-deep hover:text-fg"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </header>
        <div className="scrollbar-thin h-[calc(100%-58px)] overflow-y-auto px-4 py-3">
          {/* 내 프로필 — 양 모드 공통. 주간보고서 @AUTHOR + 이메일 인사말/기본값의 단일 소스 */}
          <section className="mb-3 rounded-card border border-rule bg-bg p-3">
            <h3 className="mb-2 text-xs font-semibold text-fg">
              {isMono ? '$ profile' : '내 프로필'}
            </h3>
            <div className="space-y-1.5">
              <ProfileInput
                label="이름"
                value={draft.name}
                placeholder="홍길동"
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
              />
              <ProfileInput
                label="이메일"
                value={draft.email}
                placeholder="hong@company.example"
                onChange={(v) => setDraft((d) => ({ ...d, email: v }))}
              />
              <ProfileInput
                label="회사"
                value={draft.company}
                placeholder="예시아이티"
                onChange={(v) => setDraft((d) => ({ ...d, company: v }))}
              />
            </div>
            <p className="mt-2 whitespace-pre-line rounded-sharp px-2 py-1.5 text-[11px] text-fg-muted" style={{ background: 'var(--bg-deep)' }}>
              {buildGreeting(draft)}
            </p>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => onProfileChange(draft)}
                className="rounded-sharp px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--bg)' }}
                disabled={!dirty || !draft.name.trim()}
              >
                저장
              </button>
            </div>
          </section>

          {isEmail ? (
            <>
              <section className="rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ email-templates' : '이메일 템플릿'}
                </h3>
                <p className="mb-2 text-[11px] text-fg-muted">
                  상단 드롭다운에서 템플릿을 고르면 폼·본문이 준비됩니다.
                </p>
                <ul className="space-y-1.5 text-[11px] text-fg-soft">
                  {getTemplates().map((t) => (
                    <li key={t.id}>
                      <span className="font-medium text-fg">{t.name}</span>
                      {t.note && <span className="text-fg-muted"> — {t.note}</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ usage' : '작성 흐름'}
                </h3>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li>1. 템플릿 선택 → 상단 <b>폼</b>에 고정 항목(요청일자·고객사 등) 입력</li>
                  <li>2. 하단 <b>본문</b>에 자유 작성 — 굵게/글머리/이미지 붙여넣기 지원</li>
                  <li>3. 우측 <b>미리보기</b>로 실제 메일 모양 확인</li>
                  <li>4. <b>Gmail 작성</b>(Ctrl+Enter) → 본문 복사 + 작성창 열림 → Ctrl+V</li>
                </ul>
                <p className="mt-2 text-[11px]" style={{ color: 'var(--stamp-amber)' }}>
                  ⚠ 이미지는 붙여넣기 시 누락될 수 있어 Gmail에서 직접 첨부를 권장합니다. 텍스트·표는 안정적으로 유지됩니다.
                </p>
              </section>

              <section className="mt-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ shortcuts' : '단축키'}
                </h3>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> &nbsp;Gmail 작성</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">C</kbd> &nbsp;HTML 복사</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">S</kbd> &nbsp;템플릿 저장 (.json)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">O</kbd> &nbsp;템플릿 열기</li>
                  <li><kbd className="kbd">F1</kbd> &nbsp;도움말 토글</li>
                </ul>
              </section>
            </>
          ) : (
          <>
          <ul className="space-y-3">
            {ROWS.map((row) => (
              <li key={row.token} className="rounded-card border border-rule bg-bg p-3">
                <div className={`mb-1 font-mono text-xs ${row.tone}`}>{row.token}</div>
                <div className="mb-1.5 text-xs text-fg-soft">{row.description}</div>
                <pre className="rounded-sharp px-2 py-1.5 text-[11px] text-fg-muted whitespace-pre-wrap" style={{ background: 'var(--bg-deep)' }}>
                  {row.example}
                </pre>
              </li>
            ))}
          </ul>

          <section className="mt-5 rounded-card border border-rule bg-bg p-3">
            <h3 className="mb-2 text-xs font-semibold text-fg">
              {isMono ? '$ flexible-syntax' : '유연 문법'}
            </h3>
            <p className="mb-2 text-[11px] text-fg-muted">
              아래 변형은 자동 보정되며 상태바·에디터에 진단으로 표시됩니다.
            </p>
            <ul className="space-y-1 text-[11px] text-fg-soft">
              <li>• 요일 생략 — <code className="font-mono"># 2026-05-11</code> → (월) 자동 보충</li>
              <li>• 점/슬래시 날짜 — <code className="font-mono">2026.5.11</code> → ISO 정규화</li>
              <li>• 채널 공백 — <code className="font-mono">유선 &amp; 메일</code> → 유선&amp;메일 수렴</li>
              <li>• @SUM 브래킷 없는 자유 텍스트 — 수용 + 경고</li>
              <li>• 에디터에서 <code className="font-mono">@</code> 입력 시 디렉티브 자동완성, <code className="font-mono"># </code> 입력 시 다음 날짜 제안</li>
            </ul>
          </section>

          <section className="mt-3 rounded-card border border-rule bg-bg p-3">
            <h3 className="mb-2 text-xs font-semibold text-fg">
              {isMono ? '$ shortcuts' : '단축키'}
            </h3>
            <ul className="space-y-1 text-[11px] text-fg-soft">
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">S</kbd> &nbsp;저장</li>
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">O</kbd> &nbsp;열기</li>
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">L</kbd> &nbsp;샘플 불러오기</li>
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">T</kbd> &nbsp;이번 주 빈 템플릿 생성</li>
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">I</kbd> &nbsp;Gmail 본문 가져오기</li>
              <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">C</kbd> &nbsp;HTML 클립보드 복사</li>
              <li><kbd className="kbd">F1</kbd> &nbsp;도움말 토글</li>
            </ul>
          </section>
          </>
          )}
        </div>
      </aside>
      <style>{`
        .kbd {
          display: inline-block;
          padding: 1px 5px;
          border-radius: 4px;
          background: var(--bg-deep);
          color: var(--fg-soft);
          font-size: 10px;
          border: 1px solid var(--rule);
          font-family: 'JetBrains Mono', monospace;
        }
      `}</style>
    </div>
  );
}

function ProfileInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-fg-soft">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      />
    </label>
  );
}
