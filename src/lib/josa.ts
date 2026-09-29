/**
 * 한국어 조사 선택 — 앞 단어 마지막 글자의 받침 유무로 이/가·을/를·은/는·과/와·으로/로를 고른다.
 * 한글이 아닌 글자(영문·숫자)로 끝나면 읽는 소리를 알 수 없어 받침 없음 쪽을 쓴다 (예: "PDF가").
 */
type JosaPair = '이/가' | '을/를' | '은/는' | '과/와' | '으로/로';

function hasFinalConsonant(word: string): { has: boolean; isRieul: boolean } | null {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  const jong = code % 28;
  return { has: jong !== 0, isRieul: jong === 8 };
}

/** `josa('메일 제목', '이/가')` → "메일 제목이", `josa('파일', '으로/로')` → "파일로" */
export function josa(word: string, pair: JosaPair): string {
  const [withF, withoutF] = pair.split('/');
  const f = hasFinalConsonant(word);
  if (!f) return `${word}${withoutF}`;
  // ㄹ 받침은 '으로' 대신 '로' (파일로, 서울로)
  if (pair === '으로/로') return `${word}${f.has && !f.isRieul ? withF : withoutF}`;
  return `${word}${f.has ? withF : withoutF}`;
}
