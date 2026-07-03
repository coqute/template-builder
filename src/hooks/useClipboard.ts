export interface CopyHtmlInput {
  html: string;
  plain: string;
}

export async function copyHtmlToClipboard({ html, plain }: CopyHtmlInput): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('이 환경에서는 클립보드 API를 사용할 수 없습니다.');
  }
  if ('write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return;
  }
  await navigator.clipboard.writeText(plain);
}

export interface ReadClipboardResult {
  html?: string;
  plain?: string;
}

export async function readClipboard(): Promise<ReadClipboardResult> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('이 환경에서는 클립보드 API를 사용할 수 없습니다.');
  }

  if ('read' in navigator.clipboard) {
    try {
      const items = await navigator.clipboard.read();
      let html: string | undefined;
      let plain: string | undefined;
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const blob = await item.getType('text/html');
          html = await blob.text();
        }
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          plain = await blob.text();
        }
      }
      if (html || plain) return { html, plain };
    } catch {
      // 권한 거부 등 — readText로 폴백
    }
  }

  const plain = await navigator.clipboard.readText();
  return { plain };
}
