import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DocTypeSwitch } from '../src/components/DocTypeSwitch';
import { OpenSplitButton } from '../src/components/ToolbarButton';
import { DOC_TYPE_MODULES, getDocTypeModule } from '../src/doctypes';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => vi.clearAllMocks());

describe('DocTypeSwitch', () => {
  const options = [
    { id: 'weekly', label: '주간보고서' },
    { id: 'email', label: '이메일' },
  ];

  it('옵션 렌더 + 활성 표시(aria-checked)', () => {
    render(<DocTypeSwitch options={options} docType="email" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: /이메일/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /주간보고서/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('클릭 시 onChange(id)', () => {
    const onChange = vi.fn();
    render(<DocTypeSwitch options={options} docType="weekly" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /이메일/ }));
    expect(onChange).toHaveBeenCalledWith('email');
  });
});

describe('OpenSplitButton', () => {
  it('최근 파일 없으면 드롭다운 버튼 비활성', () => {
    render(<OpenSplitButton onOpen={() => {}} recentFiles={[]} />);
    expect((screen.getByLabelText('최근 파일') as HTMLButtonElement).disabled).toBe(true);
  });

  it('드롭다운 열고 항목 클릭 → onOpenRecent(경로)', () => {
    const onOpenRecent = vi.fn();
    render(
      <OpenSplitButton
        onOpen={() => {}}
        recentFiles={['C:\\r\\a.md', 'C:\\r\\b.md']}
        onOpenRecent={onOpenRecent}
      />,
    );
    fireEvent.click(screen.getByLabelText('최근 파일'));
    fireEvent.click(screen.getByRole('menuitem', { name: /b\.md/ }));
    expect(onOpenRecent).toHaveBeenCalledWith('C:\\r\\b.md');
  });
});

describe('doctypes 레지스트리', () => {
  it('모듈 id는 유니크하고 필수 필드를 갖춘다', () => {
    const ids = DOC_TYPE_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of DOC_TYPE_MODULES) {
      expect(m.label).toBeTruthy();
      expect(m.badge).toBeTruthy();
      expect(typeof m.Workspace).toBe('function');
    }
  });

  it('getDocTypeModule은 미등록 id에 첫 모듈로 폴백', () => {
    expect(getDocTypeModule('ghost').id).toBe(DOC_TYPE_MODULES[0].id);
    expect(getDocTypeModule('email').id).toBe('email');
  });
});
