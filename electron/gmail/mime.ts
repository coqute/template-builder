import { randomUUID } from 'node:crypto';
import type { DraftInlineImage } from './types';

export interface MimeInput {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  images: DraftInlineImage[];
}

/** 헤더 인젝션 방지 — CR/LF 및 제어문자 제거 */
function stripHeaderUnsafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim();
}

/** 한글 등 비ASCII 제목을 RFC 2047 =?UTF-8?B?...?= 로 인코딩 (ASCII는 그대로). CR/LF 제거 후 처리 */
export function encodeSubjectRfc2047(subject: string): string {
  const safe = stripHeaderUnsafe(subject);
  if (/^[\x20-\x7E]*$/.test(safe)) return safe; // 출력가능 ASCII만이면 그대로
  const b64 = Buffer.from(safe, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** RFC 4648 base64url (Gmail API raw 필드 형식) */
export function toBase64Url(s: string | Buffer): string {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64 본문을 76자 단위로 개행 (RFC 2045) */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/**
 * RFC822 메시지 조립. 이미지가 있으면 multipart/related(text/html + CID 인라인 이미지),
 * 없으면 단일 text/html. 모든 줄바꿈 CRLF.
 */
export function buildMimeMessage(input: MimeInput): string {
  const { to, subject, html, images } = input;
  const toHeader = stripHeaderUnsafe(to); // 헤더 인젝션 방지
  const ccHeader = stripHeaderUnsafe(input.cc ?? '');
  const subjectHeader = encodeSubjectRfc2047(subject);
  const htmlB64 = wrap76(Buffer.from(html, 'utf8').toString('base64'));

  // To 다음에 (있으면) Cc, 그 다음 Subject — 헤더 인젝션 방지된 값만
  const addrHeaders = [`To: ${toHeader}`, ...(ccHeader ? [`Cc: ${ccHeader}`] : [])];

  if (!images.length) {
    return [
      ...addrHeaders,
      `Subject: ${subjectHeader}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      htmlB64,
    ].join('\r\n');
  }

  const boundary = `b_${randomUUID().replace(/-/g, '')}`;
  const lines: string[] = [
    ...addrHeaders,
    `Subject: ${subjectHeader}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
  ];
  for (const img of images) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${stripHeaderUnsafe(img.mime)}`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.cid}"`,
      '',
      wrap76(img.base64),
    );
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}
