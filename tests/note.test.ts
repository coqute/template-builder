import { describe, expect, it } from 'vitest';
import { parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { renderHtml, renderPlain } from '../src/core/renderer';
import { importFromHtml } from '../src/core/importer';

const MD = `@PREV 2026-05-11 ~ 2026-05-17
@CURRENT 2026-05-18 ~ 2026-05-24
@AUTHOR 박민수

# 2026-05-13(수)
@LOC 한강 제트플러스 4F
@CUS 한강/서원 SRE
@SUM [AB Z+] 서원 배치 작업 이관 사전 준비
1) 에이전트 설정 일괄 적용 스크립트 시험 완료
- schedule 관련 설정 프로젝트 단위 일괄 적용 테스트
> schedule 관련 설정 모두 정상 확인(기본값 : schedule.enable=true)
> 05.14 운영 프로젝트 두 곳에 일괄 적용 예정
2) 배치 자동화 스크립트 작성 완료
- 사내 시험 환경에서 확인 완료
> 작업 생성, 여러 에이전트 연결, 일괄 배포 | 정상 수행 확인
`;

describe('`>` 보조 설명(노트) 라인', () => {
  it('parser: 노트가 NOTE_PREFIX 접두로 numbered.details에 보존된다', () => {
    const r = parse(MD);
    const first = r.days[0].blocks[0].items[0].content[0];
    expect(first.kind).toBe('numbered');
    if (first.kind === 'numbered') {
      expect(first.details).toEqual([
        'schedule 관련 설정 프로젝트 단위 일괄 적용 테스트',
        '> schedule 관련 설정 모두 정상 확인(기본값 : schedule.enable=true)',
        '> 05.14 운영 프로젝트 두 곳에 일괄 적용 예정',
      ]);
    }
  });

  it('renderer HTML: `- >` 이중 마커 없이 들여쓰기+회색 노트로 출력한다', () => {
    const html = renderHtml(parse(MD));
    expect(html).not.toContain('- &gt; schedule');
    expect(html).toContain('margin-left:16px;color:#6B7280;');
    expect(html).toContain('&gt; schedule 관련 설정 모두 정상 확인');
  });

  it('renderer plain: 노트를 `> ` 접두 그대로 출력한다', () => {
    const plain = renderPlain(parse(MD));
    expect(plain).toContain('> schedule 관련 설정 모두 정상 확인');
    expect(plain).not.toContain('- > schedule');
  });

  it('serializer: 노트를 `> ` raw로 직렬화한다 (`- >` 없음)', () => {
    const md = serialize(parse(MD));
    expect(md).toContain('> schedule 관련 설정 모두 정상 확인(기본값 : schedule.enable=true)');
    expect(md).not.toContain('- > schedule');
  });

  it('roundtrip md→md: 노트 details가 동일하게 보존된다', () => {
    const a = parse(MD);
    const b = parse(serialize(a));
    expect(b.days[0].blocks[0].items[0].content).toEqual(a.days[0].blocks[0].items[0].content);
  });

  it('roundtrip md→HTML→md: importFromHtml 경유에도 노트가 보존된다', () => {
    const a = parse(MD);
    const html = renderHtml(a);
    const { report: imported } = importFromHtml(html);
    const md = serialize(imported);
    expect(md).toContain('> schedule 관련 설정 모두 정상 확인');
    expect(md).not.toContain('- > schedule');
    const b = parse(md);
    const first = b.days[0].blocks[0].items[0].content[0];
    if (first.kind === 'numbered') {
      expect(first.details.filter((d) => d.startsWith('> '))).toHaveLength(2);
    }
  });

  it('qa/bullets 블록 안의 노트도 보존된다', () => {
    const md = `@PREV 2026-05-11 ~ 2026-05-17

# 2026-05-15(금)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 수집 서비스 기동 오류 회신
<- BMS 프로세스 오류 점검 요청
-> systemctl status collector 로그 확인 안내
> 추가 로그 경로: logs/collector.log
@SUM [ABZ+] 기타 공유
- 스크립트 전달
> 사용방법은 README 참고
`;
    const r = parse(md);
    const dialog = r.days[0].blocks[0].items[0].content[0];
    expect(dialog.kind).toBe('dialog');
    if (dialog.kind === 'dialog') {
      expect(dialog.turns.at(-1)).toEqual({ kind: 'note', text: '추가 로그 경로: logs/collector.log' });
    }
    const bullets = r.days[0].blocks[0].items[1].content[0];
    expect(bullets.kind).toBe('bullets');
    if (bullets.kind === 'bullets') {
      expect(bullets.items).toEqual(['스크립트 전달', '> 사용방법은 README 참고']);
    }
    const out = serialize(r);
    expect(out).toContain('> 추가 로그 경로: logs/collector.log');
    expect(out).toContain('> 사용방법은 README 참고');
  });
});
