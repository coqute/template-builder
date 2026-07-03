/** HTML 텍스트 이스케이프 — weekly/email 렌더러 공용 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Gmail 붙여넣기용 공용 표 스타일 (인라인) */
export const MAIL_FONT = `'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', system-ui, sans-serif`;
export const MAIL_BORDER = '1px solid #7E9ACB';
export const MAIL_TEXT = `font-family:${MAIL_FONT};font-size:13px;line-height:1.6;letter-spacing:-0.01em;color:#1f2937;word-break:keep-all;overflow-wrap:break-word;`;
