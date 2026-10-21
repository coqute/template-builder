/** 낱말 단위 비교 — 확인 창에서 바뀐 부분만 표시한다 (LCS, 줄 하나 수백 낱말 이내) */
export type DiffPart = { t: 'same' | 'add' | 'del'; s: string };

function words(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = words(before);
  const b = words(after);
  // 너무 길면 통째로 바뀐 것으로 — 표시용이라 정확도보다 반응성
  if (a.length * b.length > 250_000) return [{ t: 'del', s: before }, { t: 'add', s: after }];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (t: DiffPart['t'], s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', a[i++]);
    else push('add', b[j++]);
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('add', b[j++]);
  return out;
}
