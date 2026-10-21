/** 작업일지 파일 바이트 ↔ 편집용 본문 — main 전용이지만 Electron에 기대지 않아 테스트에서 바로 쓴다 */

export interface DiskText {
  text: string;
  bom: boolean;
  crlf: boolean;
  legacyEncoding: boolean;
  buf: Buffer;
}

/** 바이트 → 편집용 본문 (BOM 떼고 줄바꿈 LF). UTF-8이 아니면 EUC-KR로 읽는다 */
export function decodeWorklog(buf: Buffer): DiskText {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  let raw: string;
  let legacyEncoding = false;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    raw = new TextDecoder('euc-kr').decode(body);
    legacyEncoding = true;
  }
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const lfCount = (raw.match(/\n/g) ?? []).length;
  const crlf = crlfCount > 0 && crlfCount === lfCount;
  return { text: raw.replace(/\r\n/g, '\n'), bom, crlf, legacyEncoding, buf };
}

/** 편집용 본문 → 바이트 (원본의 BOM·CRLF 되살림) */
export function encodeWorklog(text: string, bom: boolean, crlf: boolean): Buffer {
  const lf = text.replace(/\r\n/g, '\n');
  const body = Buffer.from(crlf ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
