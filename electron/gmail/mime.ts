import { randomUUID } from 'node:crypto';
import type { DraftInlineImage } from './types';

export interface MimeInput {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  /** 평문 대안 본문 — 있으면 multipart/alternative */
  text?: string;
  images: DraftInlineImage[];
}

/** 헤더 인젝션 방지 — CR/LF 및 제어문자 제거 */
function stripHeaderUnsafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim();
}

/** encoded-word 하나에 담는 최대 원문 바이트 — base64 60자 + `=?UTF-8?B?…?=` 래퍼 12자 = 72자 ≤ RFC 2047 상한 75자 */
const ENCODED_WORD_MAX_BYTES = 45;

/**
 * 한글 등 비ASCII 제목을 RFC 2047 =?UTF-8?B?...?= 로 인코딩 (ASCII는 그대로). CR/LF 제거 후 처리.
 * encoded-word는 75자 상한을 지켜 UTF-8 문자 경계에서 분할하고 folding whitespace(CRLF+SP)로 잇는다 —
 * 한글 15자 이상 제목이 단일 encoded-word로 상한을 넘겨 엄격한 MTA에서 접히거나 raw 노출되던 문제 방지.
 */
export function encodeSubjectRfc2047(subject: string): string {
  const safe = stripHeaderUnsafe(subject);
  if (/^[\x20-\x7E]*$/.test(safe)) return safe; // 출력가능 ASCII만이면 그대로
  const words: string[] = [];
  let chunk = '';
  for (const ch of safe) {
    if (chunk && Buffer.byteLength(chunk + ch, 'utf8') > ENCODED_WORD_MAX_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
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

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/** CID·파일명 토큰 — 헤더 안 따옴표·꺾쇠·공백이 섞이지 않게 영숫자와 `._-`만 */
function headerToken(s: string): string {
  return stripHeaderUnsafe(s).replace(/[^A-Za-z0-9._-]/g, '');
}

function base64Part(contentType: string, text: string): string[] {
  return [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(text, 'utf8').toString('base64'))];
}

/** text/html 단독, 또는 평문이 있으면 multipart/alternative(text/plain → text/html) */
function bodyPart(html: string, text: string | undefined): string[] {
  const htmlPart = base64Part('text/html; charset="UTF-8"', html);
  if (text === undefined) return htmlPart;
  const alt = `alt_${randomUUID().replace(/-/g, '')}`;
  return [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    ...base64Part('text/plain; charset="UTF-8"', text),
    `--${alt}`,
    ...htmlPart,
    `--${alt}--`,
  ];
}

/**
 * RFC822 메시지 조립. 모든 줄바꿈 CRLF.
 * - 이미지 없음: text/html 단독 (평문이 있으면 multipart/alternative)
 * - 이미지 있음: Gmail 작성창이 만드는 것과 같은 구조
 *     multipart/related
 *       ├ multipart/alternative (text/plain, text/html)   ← 평문이 없으면 text/html 단독
 *       └ image/*; name="image1.png"
 *           Content-Disposition: inline; filename="image1.png"
 *           Content-ID: <ii_…>
 *           X-Attachment-Id: ii_…
 *   Gmail은 초안을 다시 열어 편집·저장할 때 인라인 이미지를 X-Attachment-Id로 첨부와 묶는다.
 *   이 헤더 없이 만든 초안은 Gmail에서 크기를 바꾸고 보내면 이미지가 첨부와 끊겨 받는 쪽에서 깨진다.
 */
export function buildMimeMessage(input: MimeInput): string {
  const { to, subject, html, images, text } = input;
  const toHeader = stripHeaderUnsafe(to); // 헤더 인젝션 방지
  const ccHeader = stripHeaderUnsafe(input.cc ?? '');
  const subjectHeader = encodeSubjectRfc2047(subject);

  // To 다음에 (있으면) Cc, 그 다음 Subject — 헤더 인젝션 방지된 값만
  const head = [
    `To: ${toHeader}`,
    ...(ccHeader ? [`Cc: ${ccHeader}`] : []),
    `Subject: ${subjectHeader}`,
    'MIME-Version: 1.0',
  ];

  if (!images.length) {
    return [...head, ...bodyPart(html, text)].join('\r\n');
  }

  const boundary = `b_${randomUUID().replace(/-/g, '')}`;
  const lines: string[] = [
    ...head,
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...bodyPart(html, text),
  ];
  images.forEach((img, idx) => {
    // 형식은 래스터 이미지 허용 목록만 — 헤더 인젝션·임의 형식 차단 (렌더러 추출 규칙과 같음)
    const raw = stripHeaderUnsafe(img.mime).toLowerCase();
    const mime = raw === 'image/jpg' ? 'image/jpeg' : IMAGE_EXT[raw] ? raw : 'application/octet-stream';
    const cid = headerToken(img.cid);
    const filename = headerToken(img.filename ?? '') || `image${idx + 1}.${IMAGE_EXT[mime] ?? 'png'}`;
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mime}; name="${filename}"`,
      `Content-Disposition: inline; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${cid}>`,
      `X-Attachment-Id: ${cid}`,
      '',
      wrap76(img.base64),
    );
  });
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}
