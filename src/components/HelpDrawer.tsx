import { useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';
import type { DocType } from '../hooks/useDocType';
import { getTemplates } from '../email/templates';
import { buildGreeting, defaultCompany, type UserProfile } from '../email/profile';
import { loadTeamFolder, saveTeamFolder } from '../email/useTemplateOverlays';
import { loadWeeklyRecipients, saveWeeklyRecipients, type WeeklyRecipients } from '../lib/weeklyRecipients';
import { ThemeToggle } from './ThemeToggle';
import { AiSettings } from './AiSettings';
import { HomeGuide, HomeSettings } from '../planner/components/HomeHelp';

interface Props {
  open: boolean;
  onClose: () => void;
  profile: UserProfile;
  onProfileChange: (next: UserProfile) => void;
  /** 템플릿 오버레이 다시 불러오기 (팀 폴더 변경/JSON 추가 후) */
  onReloadTemplates?: () => void;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
  docType: DocType;
  /** 활성 문서 모듈의 메뉴 명령 실행 (예: 'menu:load-sample') — 실행 후 패널을 닫는다 */
  onCommand: (channel: string) => void;
}

/** 패널 안 묶음 제목 — 설정 / 가이드 */
function GroupTitle({ mono, children }: { mono: boolean; children: React.ReactNode }) {
  return (
    <div
      className={[
        'mb-2 mt-1 px-0.5 text-[11px] font-semibold text-fg-muted',
        mono ? 'tracking-wider' : 'tracking-wide',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

const ROWS: Array<{ token: string; tone: string; description: string; example: string }> = [
  {
    token: '@PREV',
    tone: 'tok-week',
    description: '보고 대상 주 (지난 주 월~일). 제목 [YYYY. MM. DD ~ YYYY. MM. DD] 주간보고 자동 생성',
    example: '@PREV 2026-09-21 ~ 2026-09-27',
  },
  {
    token: '@CURRENT · @PLAN',
    tone: 'tok-next',
    description: '다음 주 범위와 일정 — 표 아래 □ 일정 예정 (@PLAN이 있을 때만)',
    example: '@CURRENT 2026-09-28 ~ 2026-10-04\n@PLAN 2026-09-29 10:00 MX(주간미팅)\n@PLAN 2026-09-30 (종일) 가나스토어 패치',
  },
  {
    token: '# 일자',
    tone: 'tok-day',
    description: '일자 행 시작 — 월~일 7일 모두 표기. 일 없는 평일은 빈 행, 토·일은 휴일(@HOLIDAY)',
    example: '# 2026-09-21(월)\n\n# 2026-09-26(토)\n@HOLIDAY',
  },
  {
    token: '@LOC',
    tone: 'tok-loc',
    description: '지원장소 — 현장은 고객사(건물), 원격은 근무 위치: 파트너사·회사·외부·휴가',
    example: '@LOC MX(누리사옥)\n@LOC 파트너사\n@LOC 휴가',
  },
  {
    token: '@CUS',
    tone: 'tok-loc',
    description: '고객사|작업구분 — 고객사 약칭 또는 그 고객사 안의 팀·부서(항목은 [고객사]), 고객 건이 아니면 제조사문의·미팅·테스트',
    example: '@CUS MX\n@CUS 한강 SRE\n@CUS 제조사문의',
  },
  {
    token: '@SUM',
    tone: 'tok-client',
    description: '항목 머리 — 원격 (담당자/채널), 현장 (건물) (담당자). 채널: 메일·유선·메신저·슬랙·문자·카톡·현장',
    example: '@SUM [MX] (홍길동/메일) 에이전트 이름 변경 반영 안 됨\n@SUM [AB Z+] (홍길동/메신저) 이벤트 설정 문의\n@SUM [MX] (누리사옥) (홍길동) 수집서버 패치',
  },
  {
    token: '-> / <-',
    tone: 'tok-in',
    description: '대화 이력 — -> 상대방(고객·제조사) 발화, <- 내 대응. 시간순으로 번갈아',
    example: '  -> 서버 이름을 바꿔도 반영 안 됨\n  <- 에이전트 로그 공유 요청\n  -> 로그 전달',
  },
  {
    token: '*<- · *==>',
    tone: 'tok-pending',
    description: '*<- 미결 대응(진행 중·후속 남음, 상태바 "미결" 집계) · *==> 결론·후속 과제',
    example: '  *<- 제조사 문의 예정\n  *==> 디스크 장애 대응 절차 문서화 필요',
  },
  {
    token: '1)',
    tone: 'tok-num',
    description: '작업 단계·안건·다건 문의 분해 — 하위는 - 세부 / > 세부 설명',
    example: '1) 수집서버 프로세스 패치\n  > 재기동 후 수집 정상 확인',
  },
  {
    token: '- / >',
    tone: 'tok-note',
    description: '목록 줄과 노트 — - 는 헤드라인 한 줄, 바로 아래 > 는 그 줄의 보충 설명(비주얼 화면에서 들여 보임). 비주얼 화면에서 줄 앞에 > 를 치면 노트, - 를 치면 목록 줄',
    example: '- 특이사항\n> 보관기간 초과 시 자동 정리\n> 디스크 증설 요청',
  },
  {
    token: '들여쓰기',
    tone: 'tok-dash',
    description: '2칸 = 1단계 계층 (텍스트 모드 Tab/Shift+Tab). 번호 항목별 대응을 한 단계 안쪽에',
    example: '  -> 기능개선 2건 요청\n  1) 알림 본문 변수 처리\n    <- 제조사 문의 예정\n  2) 분류 이름 수정\n    <- 수정 가능 안내',
  },
  {
    token: '@HOLIDAY · @HALFDAY',
    tone: 'tok-holiday',
    description: '휴일 — 주말·공휴일 (빨간 행, 공휴일만 사유) · 반차·조퇴 (날짜 칸 주황 라벨, 근무일 유지)',
    example: '# 2026-10-09(금)\n@HOLIDAY 한글날\n\n# 2026-10-10(토)\n@HOLIDAY\n\n# 2026-09-24(목)\n@HALFDAY 오후 반차',
  },
];

export function HelpDrawer({
  open,
  onClose,
  profile,
  onProfileChange,
  onReloadTemplates,
  theme,
  onThemeChange,
  docType,
  onCommand,
}: Props) {
  const [draft, setDraft] = useState<UserProfile>(profile);
  const [teamFolder, setTeamFolder] = useState<string>(loadTeamFolder);
  const [recipients, setRecipients] = useState<WeeklyRecipients>(loadWeeklyRecipients);

  useEffect(() => {
    setDraft(profile);
  }, [profile, open]);

  // Esc 닫기 · 열리면 닫기 버튼으로 포커스 (키보드 사용자가 드로어 안에서 시작)
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const isMono = theme === 'mono';
  const isEmail = docType === 'email';
  const isWorklog = docType === 'worklog';
  const isHome = docType === 'home';
  const dirty =
    draft.name !== profile.name || draft.email !== profile.email || draft.company !== profile.company;

  return (
    <div
      className={[
        // 닫힘 = invisible — 투명·이동만 하면 안의 입력칸이 Tab 순서에 남아 보이지 않는 칸에 입력된다
        // 열 때는 즉시 visible(그래야 닫기 버튼에 포커스가 들어감), 닫을 때는 페이드 후 hidden
        'fixed inset-0 z-30',
        open
          ? 'visible opacity-100 [transition:opacity_220ms,visibility_0s]'
          : // 서랍이 다 들어간 뒤에 숨긴다 — 먼저 숨기면 들어가다 말고 사라진다 (tb-drawer-out과 같은 280ms)
            'pointer-events-none invisible opacity-0 [transition:opacity_280ms,visibility_0s_linear_280ms]',
      ].join(' ')}
      style={{ background: 'var(--scrim)' }}
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-drawer-title"
        className={[
          'absolute right-0 top-0 h-full w-[380px] border-l border-rule-strong bg-bg-elevated transition-transform',
          open ? 'tb-drawer translate-x-0' : 'tb-drawer-out translate-x-full',
        ].join(' ')}
        style={{ boxShadow: 'var(--shadow-pop)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-rule px-4 py-3">
          <div>
            <h2 id="help-drawer-title" className="text-sm font-semibold text-fg">
              {isMono ? '$ settings' : '설정 · 도움말'}
            </h2>
            <p className="text-[11px] text-fg-muted">
              {isMono ? '> press F1 to toggle' : 'F1로 다시 열고 닫을 수 있습니다.'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-sharp p-1 text-fg-muted hover:bg-bg-sunken hover:text-fg"
            aria-label="닫기 (Esc)"
          >
            <X size={16} />
          </button>
        </header>
        <div className="scrollbar-thin h-[calc(100%-58px)] overflow-y-auto px-4 py-3">
          <GroupTitle mono={isMono}>{isMono ? '# settings' : '설정'}</GroupTitle>
          {/* 내 프로필 — 양 모드 공통. 이메일 인사말·기본값의 단일 소스 */}
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
                placeholder={defaultCompany()}
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

          {!isEmail && !isWorklog && !isHome && (
            <section className="mb-3 rounded-card border border-rule bg-bg p-3">
              <h3 className="mb-2 text-xs font-semibold text-fg">
                {isMono ? '$ send' : '주간보고 발송 (임시보관함)'}
              </h3>
              <p className="mb-2 text-[11px] text-fg-muted">
                [임시보관함](Ctrl+Enter)이 이 주소로 Gmail 초안을 만듭니다. 제목·본문은 자동, 발송은 Gmail에서 직접.
              </p>
              <div className="space-y-1.5">
                <ProfileInput
                  label="받는사람"
                  value={recipients.to}
                  placeholder="팀장 주소"
                  onChange={(v) => setRecipients((r) => ({ ...r, to: v }))}
                  onBlur={() => saveWeeklyRecipients(recipients)}
                />
                <ProfileInput
                  label="참조"
                  value={recipients.cc}
                  placeholder="팀 공용 주소 (쉼표로 여러 개)"
                  onChange={(v) => setRecipients((r) => ({ ...r, cc: v }))}
                  onBlur={() => saveWeeklyRecipients(recipients)}
                />
              </div>
            </section>
          )}

          {isHome && <HomeSettings mono={isMono} open={open} />}

          {isEmail && (
            <section className="mb-3 rounded-card border border-rule bg-bg p-3">
              <h3 className="mb-2 text-xs font-semibold text-fg">
                {isMono ? '$ user-templates' : '사용자 템플릿'}
              </h3>
              <p className="mb-2 text-[11px] leading-relaxed text-fg-muted">
                개인 폴더 또는 팀 공유폴더의 <code className="font-mono">templates/*.json</code>이
                드롭다운에 추가됩니다. 팀 템플릿은 내장 양식을 덮어쓸 수 있습니다.
              </p>
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void window.reportApi?.openTemplatesDir?.()}
                  className="rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken"
                >
                  개인 템플릿 폴더 열기
                </button>
                <button
                  type="button"
                  onClick={() => onReloadTemplates?.()}
                  className="rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken"
                >
                  다시 불러오기
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-[11px] text-fg-soft">팀 폴더</span>
                <input
                  type="text"
                  value={teamFolder}
                  aria-label="팀 폴더 경로"
                  placeholder="\\server\share\TemplateBuilder"
                  onChange={(e) => setTeamFolder(e.target.value)}
                  onBlur={() => {
                    saveTeamFolder(teamFolder);
                    onReloadTemplates?.();
                  }}
                  className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-2 py-1 text-xs text-fg outline-none focus:border-fg"
                />
              </div>
            </section>
          )}

          <section className="mb-3 flex items-center justify-between gap-2 rounded-card border border-rule bg-bg p-3">
            <div>
              <h3 className="text-xs font-semibold text-fg">{isMono ? '$ theme' : '화면 테마'}</h3>
              <p className="text-[11px] text-fg-muted">메일 본문은 테마와 무관하게 흰 종이로 나갑니다.</p>
            </div>
            <ThemeToggle theme={theme} onChange={onThemeChange} />
          </section>

          {/* AI(Claude API) — 모든 탭 공통 (키·모델) */}
          <AiSettings mono={isMono} open={open} />

          <GroupTitle mono={isMono}>{isMono ? '# guide' : '가이드'}</GroupTitle>
          {isWorklog ? (
            <WorklogGuide mono={isMono} />
          ) : isHome ? (
            <HomeGuide mono={isMono} />
          ) : isEmail ? (
            <>
              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ usage' : '작성 흐름'}
                </h3>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li>1. 상단 드롭다운에서 템플릿 선택 → <b>입력항목</b>에 고정 항목(요청일자·고객사 등) 입력</li>
                  <li>2. <b>서술 → 문의</b>(Ctrl+Shift+B) — 문의하려는 내용·발생한 이슈·확인하거나 검토한 것을 편하게 적으면 제목·도입 문장·이슈·요청내용과 표의 빈 칸에 맞는 글로 바꿉니다. 결과를 고친 뒤 서식에 넣습니다</li>
                  <li>3. <b>본문</b> 탭에서 고치거나 자유 작성 — 굵게/글머리/표/이미지 붙여넣기 지원. 이미지를 누르면 모서리 끌기·<b>작게/최적 크기/원래 크기</b>로 크기 조절 (Gmail과 같음)</li>
                  <li>4. 우측 <b>미리보기</b>로 실제 메일 모양 확인</li>
                  <li>5. <b>임시보관함</b>(Ctrl+Enter) → Gmail 초안(이미지 인라인 포함) → Gmail에서 검토 후 발송</li>
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                  본문 없는 서식(라이선스 전달 등)은 <b>HTML 복사</b>도 제공합니다. 입력값 .json 열기·저장은 툴바 ⋯ 메뉴에 있습니다.
                </p>
              </section>

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ compose' : '서술 → 문의'}
                </h3>
                <ul className="space-y-1 text-[11px] leading-relaxed text-fg-soft">
                  <li>• 서술 칸에 순서 없이 적거나 고객과 나눈 대화를 붙여 넣습니다. 기술 문의는 <b>발생한 이슈 → [확인 내용] → ■ 확인 요청 사항 → ※ 참고</b> 순서의 글로 바뀝니다. 기술 문의가 아닌 서식에서는 버튼이 <b>서술 → 메일</b>로 보입니다.</li>
                  <li>• <b>서술에 없는 것은 만들지 않습니다.</b> 확인·검토한 내용이 없으면 그 단락을 비우고 "확인할 점"에 알립니다. 표의 칸은 비어 있을 때만, 서술에 글자 그대로 있는 값으로만 채웁니다.</li>
                  <li>• 날짜와 라이선스·키 칸은 읽지도 보내지도 않습니다. IP·URL·메일 주소·전화번호·키와 이름(대화 참여자·직함이 붙은 이름·내 이름)은 가려서 보냅니다.</li>
                  <li>• 본문에 이미 내용(캡처 등)이 있으면 <b>지금 본문 위에 넣기</b>와 <b>본문을 바꿔 넣기</b> 중에 고릅니다. 넣은 뒤 토스트의 <b>되돌리기</b>로 돌립니다.</li>
                </ul>
              </section>

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ email-templates' : '템플릿 목록'}
                </h3>
                <ul className="space-y-1.5 text-[11px] text-fg-soft">
                  {getTemplates().map((t) => (
                    <li key={t.id}>
                      <span className="font-medium text-fg">{t.name}</span>
                      {t.note && <span className="text-fg-muted"> — {t.note}</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ shortcuts' : '단축키'}
                </h3>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">B</kbd> &nbsp;서술 → 문의 (편하게 적은 글을 서식에 맞는 글로)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> &nbsp;임시보관함 (Gmail 초안)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">C</kbd> &nbsp;HTML 복사 (본문 없는 서식)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">N</kbd> &nbsp;새 이메일 (현재 템플릿 초기화 · 되돌리기 가능)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">S</kbd> / <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">O</kbd> &nbsp;입력값 .json 저장 / 열기</li>
                  <li><kbd className="kbd">F1</kbd> &nbsp;설정 · 도움말</li>
                </ul>
              </section>
            </>
          ) : (
            <>
              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ usage' : '작성 흐름'}
                </h3>
                <ol className="space-y-1 text-[11px] leading-relaxed text-fg-soft">
                  <li>1. <b>새 주간보고</b>(Ctrl+N) — 지난 주 월~일 빈 골격 (토·일은 휴일). 지난주 보고서의 미결 건은 위쪽 <b>지난주 미결</b> 목록으로</li>
                  <li>2. 날짜마다 행(지원장소·고객사)과 항목을 채우고 경과는 <b>대화 이력</b>으로 — 쓰지 않은 골격은 메일에 나가지 않습니다</li>
                  <li>3. 상태바 <b>미결 N</b>을 눌러 끝나지 않은 대응 점검</li>
                  <li>4. <b>임시보관함</b>(Ctrl+Enter) 또는 <b>HTML 복사</b>(Ctrl+Shift+C) — 건너뛴 주는 미리보기 <b>합본</b></li>
                </ol>
                <button
                  type="button"
                  onClick={() => onCommand('menu:load-sample')}
                  className="mt-2 rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken"
                  title="형식 예시를 불러옵니다 — 현재 초안은 토스트의 [되돌리기]로 복구"
                >
                  샘플 보기
                </button>
              </section>

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ history' : '히스토리 작성'}
                </h3>
                <ul className="space-y-1 text-[11px] leading-relaxed text-fg-soft">
                  <li>• 한 건의 경과는 <b>대화 이력</b>으로 — <code className="font-mono">-&gt;</code> 상대, <code className="font-mono">&lt;-</code> 나를 시간순으로 번갈아 씁니다.</li>
                  <li>• 비주얼: 턴 입력 중 <kbd className="kbd">Enter</kbd> = 다음 턴(비어 있으면 그 칸, 없으면 반대 방향 새 턴), <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Enter</kbd> = 줄바꿈, <kbd className="kbd">↑</kbd>/<kbd className="kbd">↓</kbd> = 턴 사이 이동, 빈 턴에서 <kbd className="kbd">Backspace</kbd> = 삭제.</li>
                  <li>• 턴 앞에 <code className="font-mono">*&lt;- </code> <code className="font-mono">*==&gt; </code> <code className="font-mono">&gt; </code> <code className="font-mono">-&gt; </code>를 치면 종류가 바뀝니다. 마커가 붙은 메일 스레드를 붙여넣으면 줄마다 턴으로 나뉩니다.</li>
                  <li>• 행의 고객사를 쓰면 항목의 빈 고객사 칸이, 지원장소 <code className="font-mono">MX(누리사옥)</code>를 쓰면 빈 건물 칸이 채워집니다.</li>
                  <li>• <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Z</kbd> 되돌리기는 추가·삭제·이동까지. 길어지면 일자 머리의 ▾ 또는 <b>모두 접기</b>로 요약만 봅니다.</li>
                  <li>• 며칠에 걸친 건은 항목의 <b>이어쓰기 →</b>로 다른 날에 머리를 복사해 그날의 경과만 이어 씁니다. 텍스트 모드는 <code className="font-mono">@SUM </code> 뒤 자동완성.</li>
                  <li>• 끝나지 않은 대응은 <code className="font-mono">*&lt;-</code>(미결) — 상태바 "미결 N"에서 해당 항목으로 이동합니다.</li>
                </ul>
              </section>

              <ul className="mb-3 space-y-3">
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

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ flexible-syntax' : '유연 문법'}
                </h3>
                <p className="mb-2 text-[11px] text-fg-muted">
                  아래 변형은 자동 보정되며 상태바·에디터에 진단으로 표시됩니다.
                </p>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li>• 요일 생략 — <code className="font-mono"># 2026-05-11</code> → (월) 자동 보충</li>
                  <li>• 점/슬래시 날짜 — <code className="font-mono">2026.5.11</code> → ISO 정규화</li>
                  <li>• 채널 공백 — <code className="font-mono">유선 &amp; 메일</code> → 유선&amp;메일 수렴. 표준 채널이 아니면 괄호 전체를 담당자로 보존 + 경고</li>
                  <li>• @SUM 브래킷 없는 자유 텍스트 — 수용 + 경고</li>
                  <li>• 인식할 수 없는 줄이 있으면 비주얼 모드를 막습니다 (편집 시 그 줄이 사라지므로)</li>
                  <li>• 에디터에서 <code className="font-mono">@</code> 디렉티브, <code className="font-mono"># </code> 다음 날짜, <code className="font-mono">@LOC </code>·<code className="font-mono">@CUS </code> 값, 줄 앞 <code className="font-mono">*</code> 미결·결론 자동완성</li>
                </ul>
              </section>

              <section className="mb-3 rounded-card border border-rule bg-bg p-3">
                <h3 className="mb-2 text-xs font-semibold text-fg">
                  {isMono ? '$ shortcuts' : '단축키'}
                </h3>
                <ul className="space-y-1 text-[11px] text-fg-soft">
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">N</kbd> &nbsp;새 주간보고 (지난 주 골격 · 되돌리기 가능)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">O</kbd> / <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">S</kbd> &nbsp;열기 / 저장</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">C</kbd> &nbsp;HTML 복사 (합본 포함)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> &nbsp;임시보관함 (받는사람·참조는 위 설정)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">I</kbd> &nbsp;Gmail 본문 가져오기 (툴바 ⋯)</li>
                  <li><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Z</kbd> / <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">Z</kbd> &nbsp;되돌리기 / 다시 실행 (비주얼은 문서 단위)</li>
                  <li><kbd className="kbd">Tab</kbd> / <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Tab</kbd> &nbsp;텍스트 모드 들여쓰기 / 내어쓰기</li>
                  <li><kbd className="kbd">F1</kbd> &nbsp;설정 · 도움말</li>
                </ul>
              </section>
            </>
          )}
          <p className="mt-4 text-center text-[10px] text-fg-faint">Template Builder v{__APP_VERSION__}</p>
        </div>
      </aside>
      <style>{`
        .kbd {
          display: inline-block;
          padding: 1px 5px;
          border-radius: var(--radius-sharp);
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

/** 작업일지 가이드 — 형식·단축키·루틴과 함께 쓰는 법 */
function WorklogGuide({ mono }: { mono: boolean }) {
  return (
    <>
      <section className="mb-3 rounded-card border border-rule bg-bg p-3">
        <h3 className="mb-2 text-xs font-semibold text-fg">{mono ? '$ format' : '형식'}</h3>
        <ul className="space-y-1 text-[11px] leading-relaxed text-fg-soft">
          <li><b>1행</b> [YYYY-MM-DD] 제목 — 파일명과 같게 (다르면 상태바 [형식 제안]에서 맞추기)</li>
          <li><b>■ (요청자/채널) 사안</b> — 무엇을 해야 했는가. 회의는 ■ 회의명 (캘린더 일정)</li>
          <li><b>※</b> ■ 바로 아래는 배경·상태, ▶ 뒤에는 내가 보낸 쿼리·스크립트(다음 줄부터 원문 그대로)</li>
          <li><b>▶</b> 내가 한 일(시간순) · <b>-</b> 확정된 사실 · <b>&nbsp;&nbsp;&gt;</b> 부연</li>
        </ul>
      </section>
      <section className="mb-3 rounded-card border border-rule bg-bg p-3">
        <h3 className="mb-2 text-xs font-semibold text-fg">{mono ? '$ keys' : '단축키'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li><span className="kbd">Ctrl+N</span> 오늘 일지 (있으면 열기 — 같은 날 파일을 둘 만들지 않음)</li>
          <li><span className="kbd">Ctrl+1~5</span> 줄 기호 ■ ▶ - &gt; ※ · <span className="kbd">Enter</span> 같은 기호로 이어 쓰기 · <span className="kbd">Tab</span> - ↔ &gt;</li>
          <li><span className="kbd">■ (</span> 뒤 요청자, <span className="kbd">/</span> 뒤 채널 자동완성 (지난 일지에서)</li>
          <li><span className="kbd">Ctrl+F</span> 전체 일지 검색 · <span className="kbd">Ctrl+Shift+B</span> 대화 → 블록 · <span className="kbd">Ctrl+Shift+D</span> 일정·할 일 달기 (커서가 있는 ■ 사안)</li>
        </ul>
      </section>
      <section className="mb-3 rounded-card border border-rule bg-bg p-3">
        <h3 className="mb-2 text-xs font-semibold text-fg">{mono ? '$ routine' : '작업일지 루틴과 함께 쓰기'}</h3>
        <p className="text-[11px] leading-relaxed text-fg-soft">
          쓰기를 멈추면 1.5초 뒤 자동 저장합니다. 루틴이 파일 끝에 덧붙이면 3초 안에 편집 중인 내용 끝에 합쳐 다시 저장하므로, 메모장처럼 덮어써서 사라지지 않습니다.
          다른 프로그램에서 파일을 고친 경우에만 멈추고 어느 쪽을 쓸지 묻습니다(덮어쓰기 전 백업). 주간보고 ⋯ 메뉴의 [작업일지에서 가져오기]로 한 주의 일지를 주간보고로 만들 수 있습니다.
        </p>
      </section>
    </>
  );
}

function ProfileInput({
  label,
  value,
  placeholder,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-fg-soft">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-2 py-1 text-xs text-fg outline-none focus:border-fg"
      />
    </label>
  );
}
