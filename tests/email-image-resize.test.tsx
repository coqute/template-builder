/**
 * 이메일 본문 이미지 크기 조절 회귀 — Gmail과 같은 작게/최적 크기/원래 크기·모서리 끌기,
 * 그리고 지정한 크기가 새니타이즈·발송 렌더·초안 MIME까지 그대로 가는지.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  BEST_FIT_WIDTH,
  SMALL_WIDTH,
  applyImageWidth,
  normalizeImageSizing,
  presetWidth,
  pxValue,
} from '../src/email/imageSize';
import { htmlToPlain, sanitizeBodyHtml } from '../src/email/sanitize';
import { decorateBodyHtml } from '../src/email/render';
import { buildMimeMessage } from '../electron/gmail/mime';
import { RichBodyEditor } from '../src/email/components/RichBodyEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => vi.clearAllMocks());

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('크기 규칙', () => {
  it('프리셋 — 원본보다 키우지 않는다 (작게·최적), 원래 크기는 원본', () => {
    expect(presetWidth('small', 1280)).toBe(SMALL_WIDTH);
    expect(presetWidth('best', 1280)).toBe(BEST_FIT_WIDTH);
    expect(presetWidth('original', 1280)).toBe(1280);
    expect(presetWidth('small', 120)).toBe(120);
    expect(presetWidth('best', 400)).toBe(400);
  });

  it('픽셀 값만 인정', () => {
    expect(pxValue('320')).toBe(320);
    expect(pxValue('320px')).toBe(320);
    expect(pxValue('100%')).toBe(0);
    expect(pxValue('auto')).toBe(0);
  });

  it('적용 — width·height 속성과 style을 함께, 비율 유지', () => {
    const img = document.createElement('img');
    img.setAttribute('width', '640');
    img.setAttribute('height', '200');
    applyImageWidth(img, 320);
    expect(img.getAttribute('width')).toBe('320');
    expect(img.getAttribute('height')).toBe('100');
    expect(img.getAttribute('style')).toBe('width:320px;max-width:100%;height:auto;');
  });

  it('정규화 — 폭이 없으면 화면 폭만 넘지 않게', () => {
    const img = document.createElement('img');
    img.setAttribute('height', '50');
    normalizeImageSizing(img);
    expect(img.getAttribute('height')).toBeNull();
    expect(img.getAttribute('style')).toBe('max-width:100%;height:auto;');
  });
});

describe('새니타이즈·발송 렌더 — 지정 크기 보존', () => {
  it('편집기가 남긴 크기는 그대로', () => {
    const out = sanitizeBodyHtml(`<img src="${PNG}" width="200" height="63" style="width:200px;max-width:100%;height:auto;">`);
    expect(out).toMatch(/width="200"/);
    expect(out).toMatch(/height="63"/);
    expect(out).toContain('width:200px;max-width:100%;height:auto;');
  });

  it('Gmail에서 붙여넣은 이미지 — style 폭만 있어도 크기를 옮겨 보존', () => {
    const out = sanitizeBodyHtml(`<img src="${PNG}" style="width: 320px; margin-right: 0px;">`);
    expect(out).toMatch(/width="320"/);
    expect(out).not.toContain('margin');
  });

  it('이미지 style의 임의 CSS는 버리고 규칙대로 다시 만든다', () => {
    const out = sanitizeBodyHtml(`<img src="${PNG}" width="100%" style="position:fixed;top:0;background:url(x)">`);
    expect(out).not.toMatch(/position|url\(|width="100%"/);
    expect(out).toContain('max-width:100%;height:auto;');
  });

  it('발송 렌더도 크기 style을 보장', () => {
    const out = decorateBodyHtml(`<p><img src="${PNG}" width="240" height="75"></p>`);
    expect(out).toContain('width:240px;max-width:100%;height:auto;');
  });

  it('평문 대안에는 이미지 자리를 표기', () => {
    expect(htmlToPlain('<p>앞</p><img src="cid:ii_1" alt="image1.png"><p>뒤</p>')).toContain('[이미지: image1.png]');
  });
});

describe('초안 MIME — 평문 대안', () => {
  it('이미지 없음 + 평문 → multipart/alternative (text/plain 먼저)', () => {
    const mime = buildMimeMessage({ to: '', subject: 't', html: '<p>본문</p>', text: '본문', images: [] });
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="');
    expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('text/html'));
  });

  it('이미지 있음 → related 안에 alternative, 그 뒤 이미지', () => {
    const mime = buildMimeMessage({
      to: '',
      subject: 't',
      html: '<img src="cid:ii_a">',
      text: '[이미지]',
      images: [{ cid: 'ii_a', mime: 'image/jpeg', base64: 'AAAA' }],
    });
    const related = mime.indexOf('multipart/related');
    const alt = mime.indexOf('multipart/alternative');
    const image = mime.indexOf('Content-Type: image/jpeg; name="image1.jpg"');
    expect(related).toBeGreaterThan(-1);
    expect(alt).toBeGreaterThan(related);
    expect(image).toBeGreaterThan(alt);
    expect(mime).toContain('X-Attachment-Id: ii_a');
  });
});

describe('편집기 — 이미지를 눌러 크기 조절', () => {
  // 이 테스트들은 "아직 디코드 전이라 원본 크기를 모르는" 이미지(naturalWidth 0)를 전제로 한다 —
  // 그때는 지정된 width 속성을 원본으로 본다. happy-dom 21은 브라우저처럼 data: 이미지의 실제 크기(이 PNG는 1×1)를
  // 읽어 주므로, 전제를 명시적으로 고정한다. (원본 크기를 아는 경우는 위 '크기 규칙'의 presetWidth 테스트가 본다.)
  const proto = HTMLImageElement.prototype;
  const saved = (['naturalWidth', 'naturalHeight'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  beforeAll(() => {
    for (const [k] of saved) Object.defineProperty(proto, k, { configurable: true, get: () => 0 });
  });
  afterAll(() => {
    for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  });

  function setup(html = `<p>앞</p><img src="${PNG}" alt="" width="640" height="200"><p>뒤</p>`) {
    const onChange = vi.fn();
    const { container } = render(<RichBodyEditor initialHtml={html} onChange={onChange} />);
    const editor = container.querySelector('.email-body-editor') as HTMLElement;
    const img = editor.querySelector('img') as HTMLImageElement;
    return { onChange, editor, img, last: () => onChange.mock.calls.at(-1)![0] as string };
  }

  it('이미지를 누르면 크기 막대가 뜨고, 작게 → 폭 200·비율 유지', () => {
    const t = setup();
    expect(screen.queryByRole('toolbar', { name: '이미지 크기' })).toBeNull();
    act(() => t.img.click());
    expect(screen.getByRole('toolbar', { name: '이미지 크기' })).toBeTruthy();
    act(() => screen.getByRole('button', { name: '작게' }).click());
    expect(t.last()).toMatch(/width="200"/);
    expect(t.last()).toMatch(/height="63"/);
    expect(t.last()).toContain('width:200px');
  });

  it('최적 크기 · 원래 크기', () => {
    const t = setup(`<img src="${PNG}" alt="" width="1200" height="400">`);
    act(() => t.img.click());
    act(() => screen.getByRole('button', { name: '최적 크기' }).click());
    expect(t.last()).toMatch(/width="600"/);
    act(() => screen.getByRole('button', { name: '원래 크기' }).click());
    // 디코드 전 환경 — 원본 폭을 모르면 마지막으로 지정된 폭을 원본으로 본다
    expect(t.last()).toMatch(/width="600"/);
  });

  it('모서리를 끌면 비율을 유지한 채 바뀌고, 놓을 때 반영된다', () => {
    const t = setup();
    act(() => t.img.click());
    const handle = document.querySelector('[data-handle="se"]') as HTMLElement;
    const calls = t.onChange.mock.calls.length;
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 20, pointerId: 1 });
    });
    expect(t.img.getAttribute('width')).toBe('560');
    expect(t.img.getAttribute('height')).toBe('175');
    expect(t.onChange.mock.calls.length).toBe(calls); // 끄는 중에는 저장하지 않는다
    act(() => {
      fireEvent.pointerUp(handle, { clientX: 20, pointerId: 1 });
    });
    expect(t.last()).toMatch(/width="560"/);
  });

  it('선택 후 Delete → 이미지 삭제, Esc → 선택 해제', () => {
    const t = setup();
    act(() => t.img.click());
    act(() => {
      fireEvent.keyDown(t.editor, { key: 'Escape' });
    });
    expect(screen.queryByRole('toolbar', { name: '이미지 크기' })).toBeNull();
    act(() => t.img.click());
    act(() => {
      fireEvent.keyDown(t.editor, { key: 'Delete' });
    });
    expect(t.editor.querySelector('img')).toBeNull();
    expect(t.last()).not.toContain('<img');
  });
});
