/**
 * 바깥에서 바뀐 작업일지 합치기 — 작업일지 루틴은 파일 끝에 덧붙이기만 한다(기존 줄 수정·삭제 없음).
 * 그래서 디스크가 "마지막으로 읽은 본문 + 꼬리"면 꼬리만 편집 중인 내용 끝에 붙이면 된다.
 * 그 밖의 변경(메모장에서 고침 등)은 어느 쪽이 맞는지 알 수 없어 사람에게 묻는다.
 */

export type ExternalChange =
  | { kind: 'none' }
  /** 편집 중인 내용이 없었다 — 디스크 본문을 그대로 쓴다 */
  | { kind: 'reload'; text: string }
  /** 루틴의 덧붙이기 — 꼬리를 편집 중인 내용 끝에 붙였다 */
  | { kind: 'appended'; text: string; tail: string }
  | { kind: 'conflict'; disk: string };

/** 끝에 덧붙은 블록을 빈 줄 하나로 이어 붙인다 */
export function appendTail(buffer: string, tail: string): string {
  const block = tail.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!block) return buffer;
  if (buffer.replace(/\s+$/, '').endsWith(block)) return buffer; // 이미 같은 내용이 끝에 있다
  const head = buffer.replace(/\n+$/, '');
  const keepEol = tail.endsWith('\n') ? '\n' : '';
  return head ? `${head}\n\n${block}${keepEol}` : `${block}${keepEol}`;
}

/**
 * 조용히 받는 것은 "끝에 덧붙음"뿐이다. 편집이 없어도 줄이 빠지거나 바뀐 디스크는 묻는다 —
 * 루틴이 덧붙이는 순간 TB 저장이 겹치면 루틴은 접두사 검사에 실패해 자기 백업으로 되돌린다.
 * 그 '짧아진 파일'을 조용히 받으면 방금 저장한 내용이 사라진다.
 */
export function reconcile(base: string, buffer: string, disk: string): ExternalChange {
  if (disk === base) return { kind: 'none' };
  if (disk === buffer) return { kind: 'reload', text: disk };
  if (disk.startsWith(base)) {
    if (buffer === base) return { kind: 'reload', text: disk };
    const tail = disk.slice(base.length);
    return { kind: 'appended', text: appendTail(buffer, tail), tail };
  }
  return { kind: 'conflict', disk };
}

/** 덧붙은 꼬리의 ■ 개수 — 알림 문구용 */
export function countCases(text: string): number {
  return text.split('\n').filter((l) => /^■(?!■)/.test(l)).length;
}
