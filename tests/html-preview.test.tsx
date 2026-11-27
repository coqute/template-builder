/**
 * 미리보기 — 글자를 넣을 때마다 문서를 다시 싣지 않고 내용만 바꾼다(v0.28.1).
 * 다시 실으면 글꼴을 다시 입히고 빈 화면이 끼어 깜빡인다. 실제 깜빡임(문서 교체 횟수)은 설치본에서 잰다 — 여기서는 동작의 모양을 본다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { HtmlPreview, patchPreview } from '../src/components/HtmlPreview';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom에 없을 수 있다 — 크기 변화는 이 테스트의 관심이 아니다
if (!('ResizeObserver' in globalThis)) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
}

/** 미리보기 문서를 흉내 낸다 — 틀(srcdoc)이 싣는 것과 같은 뼈대 */
function shell(inner = ''): Document {
  const doc = document.implementation.createHTMLDocument('미리보기');
  doc.body.innerHTML = `<div class="canvas">${inner}</div>`;
  return doc;
}
const canvasOf = (doc: Document) => doc.querySelector('.canvas') as HTMLElement;

describe('patchPreview — 실려 있는 문서의 내용만 바꾼다', () => {
  it('내용 · 배율 · 폭을 그 자리에서 바꾼다', () => {
    const doc = shell('<p>처음</p>');
    expect(patchPreview(doc, '<table><tr><td>가나스토어 점검</td></tr></table>', 0.77, 960)).toBe(true);
    expect(canvasOf(doc).querySelector('td')?.textContent).toBe('가나스토어 점검');
    expect(doc.body.style.getPropertyValue('zoom')).toBe('0.77');
    expect(canvasOf(doc).style.width).toBe('960px');
  });

  it('같은 내용이면 다시 쓰지 않는다 — 배율만 바뀌면 배율만', () => {
    const doc = shell();
    patchPreview(doc, '<p>MX 주간 미팅</p>', 1, 960);
    const node = canvasOf(doc).firstElementChild;
    patchPreview(doc, '<p>MX 주간 미팅</p>', 0.8, 680);
    expect(canvasOf(doc).firstElementChild).toBe(node); // 같은 노드 — 갈아 끼우지 않았다
    expect(doc.body.style.getPropertyValue('zoom')).toBe('0.8');
    expect(canvasOf(doc).style.width).toBe('680px');
    patchPreview(doc, '<p>MX 주간 미팅 — 고침</p>', 0.8, 680);
    expect(canvasOf(doc).textContent).toBe('MX 주간 미팅 — 고침');
  });

  it('문서가 아직 없거나 뼈대가 아니면 false — 부르는 쪽이 문서를 싣는다', () => {
    expect(patchPreview(null, '<p>x</p>', 1, 960)).toBe(false);
    const bare = document.implementation.createHTMLDocument('빈 문서');
    expect(patchPreview(bare, '<p>x</p>', 1, 960)).toBe(false);
  });
});

describe('HtmlPreview — 글자를 넣는 동안 문서를 다시 싣지 않는다', () => {
  afterEach(cleanup);

  /** 틀에 문서가 실린 것처럼 만든다(happy-dom은 srcdoc을 싣지 않는다) */
  function load(frame: HTMLIFrameElement, doc: Document) {
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => doc });
    frame.dispatchEvent(new Event('load'));
  }

  it('처음에는 문서를 싣고, 그 뒤로는 내용만 바꾼다', () => {
    const view = render(<HtmlPreview html="<p>AB Z+ 정기점검</p>" zoom="100" />);
    const frame = view.container.querySelector('iframe') as HTMLIFrameElement;
    const first = frame.srcdoc;
    expect(first).toContain('AB Z+ 정기점검');

    const doc = shell('<p>AB Z+ 정기점검</p>');
    load(frame, doc);
    expect(canvasOf(doc).textContent).toBe('AB Z+ 정기점검');

    for (const text of ['AB Z+ 정기점검 ㄱ', 'AB Z+ 정기점검 가', 'AB Z+ 정기점검 가나']) {
      view.rerender(<HtmlPreview html={`<p>${text}</p>`} zoom="100" />);
      expect(canvasOf(doc).textContent).toBe(text); // 그 자리에서 바뀐다
      expect(frame.srcdoc).toBe(first); // 문서는 다시 싣지 않는다
    }
  });

  it('문서를 싣는 사이에 바뀐 내용은 실린 직후에 맞춘다', () => {
    const view = render(<HtmlPreview html="<p>처음</p>" zoom="100" />);
    const frame = view.container.querySelector('iframe') as HTMLIFrameElement;
    view.rerender(<HtmlPreview html="<p>싣는 사이에 고침</p>" zoom="100" />); // 아직 실리지 않았다 — 문서를 다시 싣는다
    expect(frame.srcdoc).toContain('싣는 사이에 고침');
    const doc = shell('<p>처음</p>'); // 먼저 요청한 문서가 실렸다고 치자
    load(frame, doc);
    expect(canvasOf(doc).textContent).toBe('싣는 사이에 고침');
  });

  it('내용이 비면 안내 글을 그 자리에 넣는다', () => {
    const view = render(<HtmlPreview html="<p>내용</p>" zoom="100" emptyHint="왼쪽에서 입력을 시작하세요" />);
    const frame = view.container.querySelector('iframe') as HTMLIFrameElement;
    const doc = shell('<p>내용</p>');
    load(frame, doc);
    view.rerender(<HtmlPreview html="" zoom="100" emptyHint="왼쪽에서 입력을 시작하세요" />);
    expect(canvasOf(doc).textContent).toBe('왼쪽에서 입력을 시작하세요');
  });
});
