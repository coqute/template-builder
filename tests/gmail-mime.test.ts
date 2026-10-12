import { describe, expect, it } from 'vitest';
import { buildMimeMessage, encodeSubjectRfc2047, toBase64Url } from '../electron/gmail/mime';

describe('encodeSubjectRfc2047', () => {
  it('ASCII는 그대로', () => {
    expect(encodeSubjectRfc2047('Hello')).toBe('Hello');
  });

  it('한글은 =?UTF-8?B?...?= 로 인코딩 + 왕복 복원', () => {
    const subject = '[예시IT] BMS 문의 (ABZ+)';
    const enc = encodeSubjectRfc2047(subject);
    expect(enc).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const b64 = enc.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(subject);
  });
});

describe('toBase64Url', () => {
  it('base64url 문자셋(+/ 제거, 패딩 제거)', () => {
    const out = toBase64Url('a'.repeat(100));
    expect(out).not.toMatch(/[+/=]/);
  });

  it('디코드 왕복', () => {
    const s = '안녕하세요 hello';
    const url = toBase64Url(s);
    const b64 = url.replace(/-/g, '+').replace(/_/g, '/');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(s);
  });
});

describe('buildMimeMessage', () => {
  it('이미지 0개 → 단일 text/html part', () => {
    const mime = buildMimeMessage({ to: 'a@example.com', subject: 'T', html: '<p>hi</p>', images: [] });
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).not.toContain('multipart/related');
    expect(mime).toContain('To: a@example.com');
    // html base64 디코드 확인
    const b64 = mime.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('<p>hi</p>');
  });

  it('이미지 N개 → multipart/related + Gmail 작성창과 같은 인라인 이미지 파트', () => {
    const mime = buildMimeMessage({
      to: 'tech@vendor.example',
      subject: '문의',
      html: '<p>본문 <img src="cid:ii_0123456789abcdef"></p>',
      images: [{ cid: 'ii_0123456789abcdef', mime: 'image/png', base64: 'AAAA', filename: 'image1.png' }],
    });
    expect(mime).toContain('Content-Type: multipart/related; boundary="');
    expect(mime).toContain('Content-Type: image/png; name="image1.png"');
    expect(mime).toContain('Content-Disposition: inline; filename="image1.png"');
    expect(mime).toContain('Content-ID: <ii_0123456789abcdef>');
    // Gmail이 초안을 다시 열어 편집·저장할 때 인라인 이미지를 첨부와 묶는 키
    expect(mime).toContain('X-Attachment-Id: ii_0123456789abcdef');
    // 경계가 닫힘
    const boundary = mime.match(/boundary="([^"]+)"/)![1];
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    // html part가 cid 참조 보존
    expect(mime).toContain('Content-Transfer-Encoding: base64');
  });

  it('한글 제목이 헤더에 RFC2047로 들어감', () => {
    const mime = buildMimeMessage({ to: '', subject: '한글제목', html: '<p>x</p>', images: [] });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('cc 전달 시 To 다음에 Cc 헤더 1줄 (이미지 없음/있음 모두)', () => {
    const noImg = buildMimeMessage({
      to: 'support@vendor.example',
      cc: 'sales@vendor.example, biz@vendor.example',
      subject: '문의',
      html: '<p>x</p>',
      images: [],
    });
    expect(noImg).toMatch(/To: support@vendor\.example\r\nCc: sales@vendor\.example, biz@vendor\.example\r\nSubject:/);
    const withImg = buildMimeMessage({
      to: 'support@vendor.example',
      cc: 'sales@vendor.example, biz@vendor.example',
      subject: '문의',
      html: '<p><img src="cid:img1"></p>',
      images: [{ cid: 'img1', mime: 'image/png', base64: 'AAAA' }],
    });
    expect(withImg).toContain('Cc: sales@vendor.example, biz@vendor.example');
  });

  it('cc 없으면 Cc 헤더 없음', () => {
    const mime = buildMimeMessage({ to: 'a@example.com', subject: 't', html: '<p>x</p>', images: [] });
    expect(mime).not.toMatch(/\r\nCc:/);
  });

  it('cc의 CRLF 인젝션 제거', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com',
      cc: 'x@example.net\r\nBcc: evil@attacker.example',
      subject: 't',
      html: '<p>x</p>',
      images: [],
    });
    expect(mime).not.toMatch(/\r\nBcc:/);
  });

  it('헤더 인젝션 방지 — to/subject의 CRLF 제거', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com\r\nBcc: evil@attacker.example',
      subject: 'Re: foo\r\nBcc: evil@attacker.example',
      html: '<p>x</p>',
      images: [],
    });
    // 주입된 Bcc 헤더가 독립 헤더 라인으로 존재하면 안 됨
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).toContain('a@example.com');
  });

  it('헤더 인젝션 방지 — multipart(이미지 포함) 분기에서도 to의 CRLF 제거', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com\r\nBcc: attacker@evil.example',
      subject: '문의',
      html: '<p>본문 <img src="cid:img1"></p>',
      images: [{ cid: 'img1', mime: 'image/png', base64: 'AAAA' }],
    });
    // multipart 경로여야 함 (분기 검증)
    expect(mime).toContain('multipart/related');
    // 주입된 Bcc가 독립 헤더 라인으로 존재하면 안 됨
    expect(mime).not.toMatch(/\r\nBcc:/);
    // To 헤더는 정확히 1줄, 주입 값이 합쳐진 단일 라인
    const toLines = mime.split('\r\n').filter((l) => l.startsWith('To:'));
    expect(toLines).toEqual(['To: a@example.com Bcc: attacker@evil.example']);
  });

  it('헤더 인젝션 방지 — img.mime의 CRLF 제거 (multipart Content-Type)', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com',
      subject: '문의',
      html: '<p><img src="cid:img1"></p>',
      images: [
        { cid: 'img1', mime: 'image/png\r\nBcc: evil@attacker.example', base64: 'AAAA' },
      ],
    });
    expect(mime).not.toMatch(/\r\nBcc:/);
    // 허용 목록 밖 형식은 일반 바이너리로 — 주입 문자열이 헤더에 남지 않는다
    expect(mime).toContain('Content-Type: application/octet-stream; name="image1.png"');
    expect(mime).not.toMatch(/bcc/i);
  });
});
