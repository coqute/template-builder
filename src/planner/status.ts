/**
 * 작업일지 줄의 상태 낱말 — 홈의 후보 찾기가 쓰는 어휘 표 (설계 §4.3).
 *
 * 같은 낱말을 일일 작업일지 루틴의 상태 어휘와 `src/ai/worklogAi.ts`의 지침 문장이 쓴다.
 * 한쪽을 바꾸면 함께 고친다. 특정 지원팀·고객사 이름은 여기에 적지 않는다 — `회신 대기` 하나로 같은 줄이 잡히고,
 * 누구를 기다리는지는 그 앞 낱말을 그대로 가져온다.
 */

export type StatusClass = 'wait' | 'todo' | 'done';

export const STATUS_WORDS: Record<StatusClass, readonly string[]> = {
  wait: ['회신 대기', '답변 대기', '확인 대기', '대기 중'],
  todo: ['적용 여부 확인 필요', '확인 필요', '대응 예정', '문의 예정', '조회 요청 예정', '안내 예정', '전달 예정', '회신 예정', '보강'],
  done: ['안내 완료', '전달 완료', '패치 전달', '완료', '해소', '종결', '정상 확인'],
};

export interface LineStatus {
  cls: StatusClass;
  word: string;
  /** 낱말이 시작하는 자리 */
  at: number;
}

/**
 * 줄의 상태 — 줄 **끝**에 있는 상태 낱말만 본다(뒤에 닫는 괄호·마침표만 허용).
 * `… 확인 필요한 항목 정리`처럼 문장 중간에 있는 것은 상태가 아니라 서술이다(실측: 32줄 중 6줄).
 * 한 줄에 여럿이면 마지막 낱말, 같은 자리에서 끝나면 긴 낱말이 그 줄의 상태다.
 */
export function lineStatus(text: string): LineStatus | null {
  const body = text.replace(/[\s.)\]。]+$/u, '');
  let best: LineStatus | null = null;
  for (const cls of ['wait', 'todo', 'done'] as const) {
    for (const word of STATUS_WORDS[cls]) {
      if (!body.endsWith(word)) continue;
      if (!best || word.length > best.word.length) best = { cls, word, at: body.length - word.length };
    }
  }
  return best;
}

/** 기다리는 대상 — `… — 고객 회신 대기`의 `고객`. 줄머리이거나 줄표 뒤에 온 한 낱말만 가져온다 */
export function waitingOnOf(text: string, status: LineStatus): string {
  if (status.cls !== 'wait') return '';
  const before = text.slice(0, status.at).trimEnd();
  const m = /(?:^|[—–-]\s*)([^\s—–-]{1,12})$/u.exec(before);
  return m ? m[1] : '';
}
